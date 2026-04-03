import type { Body } from "../../core/physics/body/Body";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { DistanceConstraint3D } from "../../core/physics/constraints/DistanceConstraint3D";
import type { World } from "../../core/physics/world/World";
import { V, V2d } from "../../core/Vector";

export interface RopeConfig {
  /** Total number of interior particles across all segments. Default 6. */
  particleCount?: number;
  /** Mass of each particle in lbs. Default 0.5. */
  particleMass?: number;
  /** Linear damping on particles (0 = none, 1 = full). Default 0.85. */
  damping?: number;
  /** Constraint stiffness for the GS solver. Default 1e5. */
  constraintStiffness?: number;
  /** Constraint relaxation for the GS solver. Higher = more damping. Default 8. */
  constraintRelaxation?: number;
}

/** Waypoint behavior:
 * - "block": rope slides freely through based on tension (physics-driven)
 * - "winch": rope only moves when explicitly transferred (player-controlled)
 */
export type WaypointType = "block" | "winch";

/** A block, fairlead, or winch that the rope passes through. */
export interface RopeWaypoint {
  body: Body;
  localAnchor: V2d;
  z: number;
  /** Default "block" — free physics-driven transfer. */
  type?: WaypointType;
}

/**
 * One segment of the rope between two path nodes (endpoints or waypoints).
 * Each segment has its own particles and constraints.
 */
interface RopeSegment {
  particles: DynamicBody[];
  constraints: DistanceConstraint3D[];
  length: number;
}

/** A path node — either an endpoint body or a waypoint. */
interface PathNode {
  body: Body;
  localAnchor: V2d;
  z: number;
}

/** Type of each interior waypoint (indexed by waypoint, not segment). */
type WaypointTypes = WaypointType[];

/**
 * A rope modeled as a chain of lightweight 2D physics particles connected
 * by upper-limit-only distance constraints.
 *
 * The rope follows a path: endpoint A → [waypoints/blocks] → endpoint B.
 * Between each pair of adjacent path nodes there is a segment of particles.
 * At each waypoint, rope length transfers between segments based on tension
 * difference — rope slides through the block.
 *
 * Particles operate in 2D only (x,y). Z-values for rendering are
 * interpolated along the path.
 */
export class Rope {
  private readonly segments: RopeSegment[] = [];
  private readonly pathNodes: PathNode[];
  private readonly waypointTypes: WaypointTypes;

  private readonly stiffness: number;
  private readonly relaxation: number;
  private readonly particleMass: number;
  private readonly particleDamping: number;

  private totalLength: number;
  private attached: boolean = false;

  // Flattened arrays for entity system integration
  private allParticles: DynamicBody[] = [];
  private allConstraints: DistanceConstraint3D[] = [];

  // Pre-allocated output arrays
  private cachedPoints: V2d[] = [];
  private cachedPositions: [number, number][] = [];
  private cachedZValues: number[] = [];

  constructor(
    bodyA: Body,
    localAnchorA: [number, number, number],
    bodyB: Body,
    localAnchorB: [number, number, number],
    totalLength: number,
    config: RopeConfig = {},
    waypoints: RopeWaypoint[] = [],
  ) {
    this.totalLength = totalLength;
    this.stiffness = config.constraintStiffness ?? 1e5;
    this.relaxation = config.constraintRelaxation ?? 8;
    this.particleMass = config.particleMass ?? 0.5;
    this.particleDamping = config.damping ?? 0.85;

    const totalParticleCount = config.particleCount ?? 6;

    // Build the path: endpoint A → waypoints → endpoint B
    this.pathNodes = [
      {
        body: bodyA,
        localAnchor: V(localAnchorA[0], localAnchorA[1]),
        z: localAnchorA[2],
      },
      ...waypoints.map((w) => ({
        body: w.body,
        localAnchor: w.localAnchor,
        z: w.z,
      })),
      {
        body: bodyB,
        localAnchor: V(localAnchorB[0], localAnchorB[1]),
        z: localAnchorB[2],
      },
    ];

    // Store waypoint types (one per interior node)
    this.waypointTypes = waypoints.map((w) => w.type ?? "block");

    const numSegments = this.pathNodes.length - 1;

    // Compute 3D world positions for each path node
    const nodeWorld3D = this.pathNodes.map((n) =>
      n.body.toWorldFrame3D(n.localAnchor.x, n.localAnchor.y, n.z),
    );
    // 2D world positions for particle placement
    const nodeWorldPositions = this.pathNodes.map((n) =>
      n.body.toWorldFrame(n.localAnchor),
    );

    // Compute the total 3D path distance
    let totalPathDist = 0;
    const segDists: number[] = [];
    for (let s = 0; s < numSegments; s++) {
      const a = nodeWorld3D[s];
      const b = nodeWorld3D[s + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      segDists.push(dist);
      totalPathDist += dist;
    }

    // Clamp total length to at least the path distance
    if (this.totalLength < totalPathDist) {
      this.totalLength = totalPathDist;
    }

    // Distribute particles proportionally to segment distance
    const particlesPerSegment = this.distributeParticles(
      totalParticleCount,
      segDists,
      totalPathDist,
    );

    // Distribute rope length proportionally to segment distance
    const lengthPerSegment = segDists.map(
      (d) => (this.totalLength * d) / (totalPathDist || 1),
    );

    // Create segments
    for (let s = 0; s < numSegments; s++) {
      const startNode = this.pathNodes[s];
      const endNode = this.pathNodes[s + 1];
      const startWorld = nodeWorldPositions[s];
      const endWorld = nodeWorldPositions[s + 1];
      const nParticles = particlesPerSegment[s];
      const segLength = lengthPerSegment[s];

      this.segments.push(
        this.createSegment(
          startNode,
          endNode,
          startWorld,
          endWorld,
          nParticles,
          segLength,
        ),
      );
    }

    // Flatten for entity system
    this.rebuildFlatArrays();

    // Pre-allocate output arrays
    const totalPoints = totalParticleCount + this.pathNodes.length;
    this.cachedPoints = Array.from({ length: totalPoints }, () => V(0, 0));
    this.cachedPositions = Array.from(
      { length: totalPoints },
      () => [0, 0] as [number, number],
    );
    this.cachedZValues = new Array(totalPoints).fill(0);
  }

  /**
   * Distribute N particles across segments proportionally to distance,
   * ensuring each segment gets at least 1.
   */
  private distributeParticles(
    total: number,
    segDists: number[],
    totalDist: number,
  ): number[] {
    const n = segDists.length;
    if (n === 1) return [total];

    // Proportional allocation with minimum 1 per segment
    const result = segDists.map(() => 1);
    let remaining = total - n;
    if (remaining > 0 && totalDist > 0) {
      // Distribute remaining proportionally
      const fractional = segDists.map((d) => (remaining * d) / totalDist);
      // Round with largest-remainder method
      const floored = fractional.map(Math.floor);
      let allocated = floored.reduce((a, b) => a + b, 0);
      const remainders = fractional.map((f, i) => ({
        i,
        r: f - floored[i],
      }));
      remainders.sort((a, b) => b.r - a.r);
      for (let j = 0; allocated < remaining && j < remainders.length; j++) {
        floored[remainders[j].i]++;
        allocated++;
      }
      for (let i = 0; i < n; i++) {
        result[i] += floored[i];
      }
    }
    return result;
  }

  private createSegment(
    startNode: PathNode,
    endNode: PathNode,
    startWorld: V2d,
    endWorld: V2d,
    nParticles: number,
    segLength: number,
  ): RopeSegment {
    const startZ = startNode.z;
    const endZ = endNode.z;
    const dx = endWorld[0] - startWorld[0];
    const dy = endWorld[1] - startWorld[1];
    const dz = endZ - startZ;

    // Create 3D particles along straight line, with interpolated velocity.
    const velA = startNode.body.velocity;
    const velB = endNode.body.velocity;
    const particles: DynamicBody[] = [];
    for (let i = 0; i < nParticles; i++) {
      const t = (i + 1) / (nParticles + 1);
      const particle = new DynamicBody({
        mass: this.particleMass,
        position: [startWorld[0] + dx * t, startWorld[1] + dy * t],
        fixedRotation: true,
        damping: this.particleDamping,
        allowSleep: false,
        sixDOF: {
          rollInertia: 1,
          pitchInertia: 1,
          zMass: this.particleMass,
          zDamping: this.particleDamping,
          rollPitchDamping: 0,
          zPosition: startZ + dz * t,
        },
      });
      particle.velocity[0] = velA[0] + (velB[0] - velA[0]) * t;
      particle.velocity[1] = velA[1] + (velB[1] - velA[1]) * t;
      particles.push(particle);
    }

    // Create 3D constraints
    const constraints: DistanceConstraint3D[] = [];
    const constraintSegLen = segLength / (nParticles + 1);

    // Start node → first particle
    constraints.push(
      this.makeConstraint(
        startNode.body,
        [startNode.localAnchor.x, startNode.localAnchor.y, startZ],
        particles[0],
        [0, 0, 0],
        constraintSegLen,
      ),
    );

    // Particle-to-particle
    for (let i = 0; i < nParticles - 1; i++) {
      constraints.push(
        this.makeConstraint(
          particles[i],
          [0, 0, 0],
          particles[i + 1],
          [0, 0, 0],
          constraintSegLen,
        ),
      );
    }

    // Last particle → end node
    constraints.push(
      this.makeConstraint(
        particles[nParticles - 1],
        [0, 0, 0],
        endNode.body,
        [endNode.localAnchor.x, endNode.localAnchor.y, endZ],
        constraintSegLen,
      ),
    );

    return { particles, constraints, length: segLength };
  }

  private makeConstraint(
    a: Body,
    anchorA: [number, number, number],
    b: Body,
    anchorB: [number, number, number],
    segLen: number,
  ): DistanceConstraint3D {
    const c = new DistanceConstraint3D(a, b, {
      localAnchorA: anchorA,
      localAnchorB: anchorB,
      distance: segLen,
      collideConnected: false,
    });
    c.upperLimitEnabled = true;
    c.lowerLimitEnabled = false;
    c.upperLimit = segLen;
    for (const eq of c.equations) {
      eq.stiffness = this.stiffness;
      eq.relaxation = this.relaxation;
    }
    return c;
  }

  private rebuildFlatArrays(): void {
    this.allParticles = [];
    this.allConstraints = [];
    for (const seg of this.segments) {
      this.allParticles.push(...seg.particles);
      this.allConstraints.push(...seg.constraints);
    }
  }

  /** Add all particles and constraints to the physics world. */
  attach(world: World): void {
    if (this.attached) return;
    for (const p of this.allParticles) {
      world.bodies.add(p);
    }
    for (const c of this.allConstraints) {
      world.constraints.add(c);
    }
    this.attached = true;
  }

  /** Remove all particles and constraints from the physics world. */
  detach(world: World): void {
    if (!this.attached) return;
    for (const c of this.allConstraints) {
      world.constraints.remove(c);
    }
    for (const p of this.allParticles) {
      world.bodies.remove(p);
    }
    this.attached = false;
  }

  /**
   * Per-tick update. Maintains particle z-heights and transfers rope
   * length through blocks based on constraint violations.
   */
  tick(_dt: number): void {
    if (this.segments.length < 2) return;

    for (let w = 0; w < this.segments.length - 1; w++) {
      // Only auto-transfer at block waypoints, not winches
      if (this.waypointTypes[w] !== "block") continue;

      const segA = this.segments[w];
      const segB = this.segments[w + 1];

      // The block-adjacent constraints: last of segA, first of segB
      const constraintA = segA.constraints[segA.constraints.length - 1];
      const constraintB = segB.constraints[0];

      // How much each side's actual distance exceeds its upper limit.
      // Positive = violated (taut), zero or negative = slack.
      const violationA = constraintA.position - constraintA.upperLimit;
      const violationB = constraintB.position - constraintB.upperLimit;

      const minSegLen = 0.1;

      if (violationA > 0.001 && violationB <= 0) {
        // Side A is taut — feed rope from B to A (exactly the violation)
        const give = Math.min(violationA, constraintB.upperLimit - minSegLen);
        if (give <= 0) continue;
        constraintA.upperLimit += give;
        constraintA.distance = constraintA.upperLimit;
        constraintB.upperLimit -= give;
        constraintB.distance = constraintB.upperLimit;
        segA.length += give;
        segB.length -= give;
      } else if (violationB > 0.001 && violationA <= 0) {
        // Side B is taut — feed rope from A to B (exactly the violation)
        const give = Math.min(violationB, constraintA.upperLimit - minSegLen);
        if (give <= 0) continue;
        constraintB.upperLimit += give;
        constraintB.distance = constraintB.upperLimit;
        constraintA.upperLimit -= give;
        constraintA.distance = constraintA.upperLimit;
        segB.length += give;
        segA.length -= give;
      }
    }
  }

  /**
   * Manually transfer rope through a waypoint (e.g. winch).
   * Positive amount = move rope from before the waypoint to after it
   * (i.e. the before-segment gets shorter, after-segment gets longer).
   *
   * @param waypointIndex 0-based index into the waypoints array
   * @param amount Rope length to transfer (ft). Positive = before→after.
   * @returns Actual amount transferred (may be clamped).
   */
  transferAtWaypoint(waypointIndex: number, amount: number): number {
    const segBefore = this.segments[waypointIndex];
    const segAfter = this.segments[waypointIndex + 1];
    if (!segBefore || !segAfter) return 0;

    const constraintBefore =
      segBefore.constraints[segBefore.constraints.length - 1];
    const constraintAfter = segAfter.constraints[0];

    const minSegLen = 0.1;

    // Clamp to available rope on the giving side
    let actual = amount;
    if (actual > 0) {
      // Moving rope from before → after: before gets shorter
      actual = Math.min(actual, constraintBefore.upperLimit - minSegLen);
    } else {
      // Moving rope from after → before: after gets shorter
      actual = Math.max(actual, -(constraintAfter.upperLimit - minSegLen));
    }

    if (Math.abs(actual) < 1e-6) return 0;

    constraintBefore.upperLimit -= actual;
    constraintBefore.distance = constraintBefore.upperLimit;
    constraintAfter.upperLimit += actual;
    constraintAfter.distance = constraintAfter.upperLimit;
    segBefore.length -= actual;
    segAfter.length += actual;

    return actual;
  }

  /**
   * Get the total length of segments before a given waypoint.
   * Useful for querying the "working length" of rope on the sail side of a winch.
   */
  getLengthBeforeWaypoint(waypointIndex: number): number {
    let total = 0;
    for (let i = 0; i <= waypointIndex; i++) {
      total += this.segments[i].length;
    }
    return total;
  }

  /**
   * Get the total length of segments after a given waypoint.
   */
  getLengthAfterWaypoint(waypointIndex: number): number {
    let total = 0;
    for (let i = waypointIndex + 1; i < this.segments.length; i++) {
      total += this.segments[i].length;
    }
    return total;
  }

  /**
   * Update the total rope length. Distributes evenly across all
   * constraints in all segments.
   */
  setLength(length: number): void {
    this.totalLength = length;
    const totalConstraints = this.allConstraints.length;
    const segLen = Math.max(0.01, length / totalConstraints);
    for (const c of this.allConstraints) {
      c.upperLimit = segLen;
      c.distance = segLen;
    }
    // Update segment lengths
    for (const seg of this.segments) {
      seg.length = segLen * seg.constraints.length;
    }
  }

  /**
   * Release the rope to guaranteed slack. Sets length to at least the
   * current total path distance so no constraints are violated.
   */
  releaseToSlack(minLength: number): void {
    let pathDist = 0;
    for (let i = 0; i < this.pathNodes.length - 1; i++) {
      const ni = this.pathNodes[i];
      const nj = this.pathNodes[i + 1];
      const a = ni.body.toWorldFrame3D(
        ni.localAnchor.x,
        ni.localAnchor.y,
        ni.z,
      );
      const b = nj.body.toWorldFrame3D(
        nj.localAnchor.x,
        nj.localAnchor.y,
        nj.z,
      );
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      pathDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.setLength(Math.max(minLength, pathDist));
  }

  /** Get the current total rope length. */
  getLength(): number {
    return this.totalLength;
  }

  /**
   * Get world-space rope points along the full path:
   * [nodeA, seg0 particles, node1, seg1 particles, ..., nodeB]
   * Returns a cached array of V2d — do not hold references across frames.
   */
  getPoints(): readonly V2d[] {
    let idx = 0;
    for (let s = 0; s < this.segments.length; s++) {
      // Path node at the start of this segment
      const node = this.pathNodes[s];
      const nw = node.body.toWorldFrame(node.localAnchor);
      this.cachedPoints[idx].x = nw[0];
      this.cachedPoints[idx].y = nw[1];
      idx++;

      // Segment particles
      for (const p of this.segments[s].particles) {
        this.cachedPoints[idx].x = p.position[0];
        this.cachedPoints[idx].y = p.position[1];
        idx++;
      }
    }

    // Final path node (endpoint B)
    const lastNode = this.pathNodes[this.pathNodes.length - 1];
    const lw = lastNode.body.toWorldFrame(lastNode.localAnchor);
    this.cachedPoints[idx].x = lw[0];
    this.cachedPoints[idx].y = lw[1];

    return this.cachedPoints;
  }

  /**
   * Get world-space rope points with real z-values from 3D particle positions.
   */
  getPointsWithZ(): {
    points: [number, number][];
    z: number[];
  } {
    let idx = 0;

    for (let s = 0; s < this.segments.length; s++) {
      const startNode = this.pathNodes[s];
      const [sx, sy, sz] = startNode.body.toWorldFrame3D(
        startNode.localAnchor.x,
        startNode.localAnchor.y,
        startNode.z,
      );

      // Start node
      this.cachedPositions[idx][0] = sx;
      this.cachedPositions[idx][1] = sy;
      this.cachedZValues[idx] = sz;
      idx++;

      // Particles — real z from 6DOF
      for (const p of this.segments[s].particles) {
        this.cachedPositions[idx][0] = p.position[0];
        this.cachedPositions[idx][1] = p.position[1];
        this.cachedZValues[idx] = p.z;
        idx++;
      }
    }

    // Final endpoint
    const lastNode = this.pathNodes[this.pathNodes.length - 1];
    const [ex, ey, ez] = lastNode.body.toWorldFrame3D(
      lastNode.localAnchor.x,
      lastNode.localAnchor.y,
      lastNode.z,
    );
    this.cachedPositions[idx][0] = ex;
    this.cachedPositions[idx][1] = ey;
    this.cachedZValues[idx] = ez;

    return { points: this.cachedPositions, z: this.cachedZValues };
  }

  /** Find the index of the first waypoint with the given type, or -1. */
  findWaypoint(type: WaypointType): number {
    return this.waypointTypes.indexOf(type);
  }

  /** Whether the rope is currently attached to a physics world. */
  isAttached(): boolean {
    return this.attached;
  }

  /** All interior particle bodies across all segments. */
  getParticles(): readonly DynamicBody[] {
    return this.allParticles;
  }

  /** All constraints across all segments. */
  getConstraints(): readonly DistanceConstraint3D[] {
    return this.allConstraints;
  }

  /** World positions of waypoints (blocks), for rendering. */
  getWaypointPositions(): V2d[] {
    // Path nodes excluding first (endpoint A) and last (endpoint B)
    const result: V2d[] = [];
    for (let i = 1; i < this.pathNodes.length - 1; i++) {
      const node = this.pathNodes[i];
      result.push(node.body.toWorldFrame(node.localAnchor));
    }
    return result;
  }
}
