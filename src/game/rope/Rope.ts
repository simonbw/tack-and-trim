/**
 * A rope modeled as one continuous chain of lightweight physics particles
 * connected by upper-limit-only distance constraints.
 *
 * Blocks (pulleys) and winches are additional constraints layered on top:
 * - Block: PulleyConstraint3D (3-body, enforces combined path length, rope slides freely)
 * - Winch: Pin constraint (locks one particle, player advances to trim/ease)
 *          + PulleyConstraint3D (forces rope through the winch point)
 *
 * No segments. No transfer. No absorb/spawn. The solver does the work.
 */

import type { Body } from "../../core/physics/body/Body";
import type { Constraint } from "../../core/physics/constraints/Constraint";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { DistanceConstraint3D } from "../../core/physics/constraints/DistanceConstraint3D";
import {
  PulleyConstraint3D,
  type PulleyMode,
} from "../../core/physics/constraints/PulleyConstraint3D";
import type { World } from "../../core/physics/world/World";
import { V, V2d } from "../../core/Vector";

export interface RopeConfig {
  /** Total number of interior particles. Default 24. */
  particleCount?: number;
  /** Mass of each particle in lbs. Default 0.5. */
  particleMass?: number;
  /** Linear damping on particles (0 = none, 1 = full). Default 0.85. */
  damping?: number;
  /** Constraint stiffness for the GS solver. Default 1e5. */
  constraintStiffness?: number;
  /** Constraint relaxation for the GS solver. Higher = more damping. Default 8. */
  constraintRelaxation?: number;
  /** If true, the B endpoint is free (bitter end hangs loose). Default false. */
  freeEndB?: boolean;
}

/** Waypoint behavior:
 * - "block": rope slides freely through (PulleyConstraint3D)
 * - "winch": rope locked in place (pin constraint), player advances to trim
 */
export type WaypointType = "block" | "winch";

/** A block, fairlead, or winch that the rope passes through. */
export interface RopeWaypoint {
  body: Body;
  localAnchor: V2d;
  z: number;
  /** Default "block" — free physics-driven sliding. */
  type?: WaypointType;
}

/** Internal state for a pulley at a block or winch waypoint. */
interface PulleyState {
  constraint: PulleyConstraint3D;
  /**
   * Pulley position along the particle chain.
   * - Half-integer (e.g. 3.5): straddle mode — pulley between p_3 and p_4,
   *   constraint spans 1 chain link.
   * - Integer (e.g. 3): contained mode — pulley "swallows" p_3,
   *   constraint spans p_2 to p_4 (2 chain links).
   */
  state: number;
  /**
   * Current particle index referenced by the constraint's bodyA (side A).
   * Straddle s=K+0.5 → K; contained s=K → K-1. Tracked explicitly so we can
   * shift the ratchet lock by the chain-length delta when swapping.
   */
  indexA: number;
  /** The waypoint body anchor in local coordinates. */
  localAnchor: [number, number, number];
  /** The waypoint body. */
  body: Body;
}

/**
 * Internal state for a winch.
 * A winch IS a pulley — the ratchet/free mode is built into the
 * PulleyConstraint3D itself. No separate grip constraint needed.
 */
interface WinchState {
  /** Index into the pulleys array — the winch IS a pulley. */
  pulleyIndex: number;
}

export class Rope {
  // The continuous particle chain
  private particles: DynamicBody[];
  private chainConstraints: DistanceConstraint3D[];
  private chainLinkLength: number;

  // Endpoints
  private endpointA: { body: Body; anchor: [number, number, number] };
  private endpointB: { body: Body; anchor: [number, number, number] };

  // Pulley constraints at waypoints
  private pulleys: PulleyState[] = [];

  // Winch state
  private winches: WinchState[] = [];

  // Waypoint data for rendering
  private waypointData: {
    body: Body;
    localAnchor: V2d;
    z: number;
    type: WaypointType;
    pulleyIndex: number;
  }[] = [];

  private readonly stiffness: number;
  private readonly relaxation: number;
  private readonly particleMass: number;
  private readonly particleDamping: number;
  private totalLength: number;
  private readonly freeEndB: boolean;
  private attached: boolean = false;

  // Pre-allocated output arrays
  private cachedPositions: [number, number][] = [];
  private cachedZValues: number[] = [];

  /**
   * Fraction of chainLinkLength: particle must be this close to the pulley
   * to enter contained mode. Kept small so the straddle↔contained constraint
   * swap is near-continuous (at threshold 0 it is exactly continuous, but we
   * need headroom larger than the max particle motion per tick to avoid
   * skipping past the switch point).
   */
  private static readonly CONTAIN_ENTER_FRACTION = 0.25;
  /**
   * Fraction of chainLinkLength: contained particle must drift this far
   * from the pulley to exit contained mode back to straddle.
   * Wider than enter threshold to prevent oscillation.
   */
  private static readonly CONTAIN_EXIT_FRACTION = 0.5;

  constructor(
    bodyA: Body,
    localAnchorA: [number, number, number],
    bodyB: Body,
    localAnchorB: [number, number, number],
    totalLength: number,
    config: RopeConfig = {},
    waypoints: RopeWaypoint[] = [],
  ) {
    this.stiffness = config.constraintStiffness ?? 1e5;
    this.relaxation = config.constraintRelaxation ?? 8;
    this.particleMass = config.particleMass ?? 0.5;
    this.particleDamping = config.damping ?? 0.85;
    this.freeEndB = config.freeEndB ?? false;

    const numParticles = config.particleCount ?? 24;

    this.endpointA = {
      body: bodyA,
      anchor: [...localAnchorA],
    };
    this.endpointB = {
      body: bodyB,
      anchor: [...localAnchorB],
    };

    // Build the full path: endpoint A → waypoints → endpoint B
    const pathNodes = [
      {
        body: bodyA,
        x: localAnchorA[0],
        y: localAnchorA[1],
        z: localAnchorA[2],
      },
      ...waypoints.map((w) => ({
        body: w.body,
        x: w.localAnchor.x,
        y: w.localAnchor.y,
        z: w.z,
      })),
      {
        body: bodyB,
        x: localAnchorB[0],
        y: localAnchorB[1],
        z: localAnchorB[2],
      },
    ];

    // Compute world positions and cumulative distances along the path
    const worldPos = pathNodes.map((n) => n.body.toWorldFrame3D(n.x, n.y, n.z));
    const worldPos2D = pathNodes.map((n) => n.body.toWorldFrame(V(n.x, n.y)));
    let totalPathDist = 0;
    const cumulDist = [0];
    for (let i = 1; i < worldPos.length; i++) {
      const [ax, ay, az] = worldPos[i - 1];
      const [bx, by, bz] = worldPos[i];
      totalPathDist += Math.sqrt(
        (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2,
      );
      cumulDist.push(totalPathDist);
    }

    // Ensure total rope length is at least the path distance
    this.totalLength = Math.max(totalLength, totalPathDist);

    // Chain link length: total rope / (numParticles + 1) links
    this.chainLinkLength = this.totalLength / (numParticles + 1);

    // Create particles uniformly spaced along the path
    this.particles = [];
    const velA = bodyA.velocity;
    const velB = bodyB.velocity;
    for (let i = 0; i < numParticles; i++) {
      const t = (i + 1) / (numParticles + 1);
      const distAlongPath = t * totalPathDist;

      // Find which path segment this distance falls in
      let segIdx = 0;
      for (let s = 1; s < cumulDist.length; s++) {
        if (cumulDist[s] >= distAlongPath) {
          segIdx = s - 1;
          break;
        }
      }

      // Interpolate within the segment
      const segStart = cumulDist[segIdx];
      const segEnd = cumulDist[segIdx + 1];
      const segT =
        segEnd > segStart
          ? (distAlongPath - segStart) / (segEnd - segStart)
          : 0;

      const posA2D = worldPos2D[segIdx];
      const posB2D = worldPos2D[segIdx + 1];
      const px = posA2D[0] + segT * (posB2D[0] - posA2D[0]);
      const py = posA2D[1] + segT * (posB2D[1] - posA2D[1]);
      const pz =
        worldPos[segIdx][2] +
        segT * (worldPos[segIdx + 1][2] - worldPos[segIdx][2]);

      const particle = new DynamicBody({
        mass: this.particleMass,
        position: [px, py],
        fixedRotation: true,
        damping: this.particleDamping,
        allowSleep: false,
        sixDOF: {
          rollInertia: 1,
          pitchInertia: 1,
          zMass: this.particleMass,
          zDamping: this.particleDamping,
          rollPitchDamping: 0,
          zPosition: pz,
        },
      });
      // Interpolate velocity
      particle.velocity[0] = velA[0] + t * (velB[0] - velA[0]);
      particle.velocity[1] = velA[1] + t * (velB[1] - velA[1]);
      this.particles.push(particle);
    }

    // Create chain constraints: endpointA → P₀ → P₁ → ... → Pₙ → endpointB
    this.chainConstraints = [];
    const linkLen = this.chainLinkLength;

    // Endpoint A → first particle
    this.chainConstraints.push(
      this.makeChainConstraint(
        bodyA,
        localAnchorA,
        this.particles[0],
        [0, 0, 0],
        linkLen,
      ),
    );

    // Particle to particle
    for (let i = 0; i < numParticles - 1; i++) {
      this.chainConstraints.push(
        this.makeChainConstraint(
          this.particles[i],
          [0, 0, 0],
          this.particles[i + 1],
          [0, 0, 0],
          linkLen,
        ),
      );
    }

    // Last particle → endpoint B (only if B is attached)
    if (!this.freeEndB) {
      this.chainConstraints.push(
        this.makeChainConstraint(
          this.particles[numParticles - 1],
          [0, 0, 0],
          bodyB,
          localAnchorB,
          linkLen,
        ),
      );
    }

    // Create pulley constraints at waypoints
    for (let w = 0; w < waypoints.length; w++) {
      const wp = waypoints[w];
      const wpDist = cumulDist[w + 1]; // waypoint is pathNode[w+1]
      const wpAnchor: [number, number, number] = [
        wp.localAnchor.x,
        wp.localAnchor.y,
        wp.z,
      ];

      // Find the two particles straddling this waypoint.
      // Clamp so there's always at least one particle on each side
      // (the state machine needs neighbors for contained mode).
      let indexA = 0;
      let indexB = numParticles - 1;
      for (let i = 0; i < numParticles; i++) {
        const particleDist = ((i + 1) / (numParticles + 1)) * totalPathDist;
        if (particleDist < wpDist) {
          indexA = i;
        } else {
          indexB = i;
          break;
        }
      }
      // Ensure at least one particle exists on each side of the pulley
      indexA = Math.min(indexA, numParticles - 2);
      indexB = Math.max(indexB, indexA + 1);

      // Create PulleyConstraint3D
      const pulley = new PulleyConstraint3D(
        this.particles[indexA],
        this.particles[indexB],
        wp.body,
        {
          localAnchorA: [0, 0, 0],
          localAnchorB: [0, 0, 0],
          localAnchorC: wpAnchor,
          // Total length = the chain link distance between these two particles
          // This is the rope that passes through the block
          totalLength: linkLen,
          collideConnected: true,
        },
      );
      for (const eq of pulley.equations) {
        eq.stiffness = this.stiffness;
        eq.relaxation = this.relaxation;
      }

      const pulleyState: PulleyState = {
        constraint: pulley,
        state: indexA + 0.5, // start in straddle mode
        indexA, // straddle(K+0.5): constraint bodyA = particles[K]
        localAnchor: wpAnchor,
        body: wp.body,
      };
      this.pulleys.push(pulleyState);

      // Store waypoint data for rendering
      this.waypointData.push({
        body: wp.body,
        localAnchor: wp.localAnchor,
        z: wp.z,
        type: wp.type ?? "block",
        pulleyIndex: this.pulleys.length - 1,
      });

      // For winch waypoints, record the winch and start in ratchet mode
      if (wp.type === "winch") {
        pulley.setMode("ratchet");
        this.winches.push({
          pulleyIndex: this.pulleys.length - 1,
        });
      }
    }

    // Pre-allocate output arrays
    // Points: endpointA + particles + waypoints (inserted) + endpointB
    this.rebuildCachedArrays();
  }

  private makeChainConstraint(
    a: Body,
    anchorA: [number, number, number],
    b: Body,
    anchorB: [number, number, number],
    length: number,
  ): DistanceConstraint3D {
    const c = new DistanceConstraint3D(a, b, {
      localAnchorA: anchorA,
      localAnchorB: anchorB,
      distance: length,
      collideConnected: true,
    });
    c.upperLimitEnabled = true;
    c.lowerLimitEnabled = false;
    c.upperLimit = length;
    for (const eq of c.equations) {
      eq.stiffness = this.stiffness;
      eq.relaxation = this.relaxation;
    }
    return c;
  }

  private rebuildCachedArrays(): void {
    const totalPoints = this.getPointCount();
    this.cachedPositions = Array.from(
      { length: totalPoints },
      () => [0, 0] as [number, number],
    );
    this.cachedZValues = new Array(totalPoints).fill(0);
  }

  /** Total number of rendered points (endpoints + particles + one per waypoint). */
  private getPointCount(): number {
    const endpoints = this.freeEndB ? 1 : 2;
    return endpoints + this.particles.length + this.pulleys.length;
  }

  // ---- Physics world management ----

  attach(world: World): void {
    if (this.attached) return;
    for (const p of this.particles) world.bodies.add(p);
    for (const c of this.chainConstraints) world.constraints.add(c);
    for (const ps of this.pulleys) world.constraints.add(ps.constraint);
    this.attached = true;
  }

  detach(world: World): void {
    if (!this.attached) return;
    for (const ps of this.pulleys) world.constraints.remove(ps.constraint);
    for (const c of this.chainConstraints) world.constraints.remove(c);
    for (const p of this.particles) world.bodies.remove(p);
    this.attached = false;
  }

  // ---- Per-tick update ----

  tick(_dt: number): void {
    for (const ps of this.pulleys) {
      this.updatePulleyState(ps);
    }
  }

  /**
   * Two-mode pulley state machine.
   *
   * Straddle mode (s = half-integer): pulley sits between two adjacent
   * particles, constraint spans 1 chain link.
   *
   * Contained mode (s = integer): a particle has reached the pulley and
   * is "swallowed." The constraint widens to span the neighbors on both
   * sides (2 chain links), avoiding the degenerate near-pulley regime.
   *
   * @returns true if the mode changed (straddle↔contained), requiring
   * a rebuild of cached render arrays.
   */
  private updatePulleyState(ps: PulleyState): boolean {
    const enterDist = Rope.CONTAIN_ENTER_FRACTION * this.chainLinkLength;
    const exitDist = Rope.CONTAIN_EXIT_FRACTION * this.chainLinkLength;

    // Compute pulley world position
    const [px, py, pz] = ps.body.toWorldFrame3D(...ps.localAnchor);

    if (!Number.isInteger(ps.state)) {
      // ---- Straddle mode ----
      const indexA = ps.state - 0.5;
      const indexB = ps.state + 0.5;
      const distA = this.particleDistTo(indexA, px, py, pz);
      const distB = this.particleDistTo(indexB, px, py, pz);

      // Check if either particle is close enough to enter contained mode
      if (distA < enterDist && this.canContain(indexA)) {
        ps.state = indexA;
        this.applyPulleyConstraint(ps, indexA - 1, indexA + 1, 2);
        return true;
      }
      if (distB < enterDist && this.canContain(indexB)) {
        ps.state = indexB;
        this.applyPulleyConstraint(ps, indexB - 1, indexB + 1, 2);
        return true;
      }
    } else {
      // ---- Contained mode ----
      const containedIdx = ps.state;
      const distContained = this.particleDistTo(containedIdx, px, py, pz);

      if (distContained > exitDist) {
        // Contained particle drifted away — pick the better straddle side.
        // Compare total path distance for each candidate straddle configuration.
        const canLow = containedIdx - 1 >= 0;
        const canHigh = containedIdx + 1 < this.particles.length;
        const costLow = canLow
          ? this.particleDistTo(containedIdx - 1, px, py, pz) + distContained
          : Infinity;
        const costHigh = canHigh
          ? distContained + this.particleDistTo(containedIdx + 1, px, py, pz)
          : Infinity;

        if (costLow <= costHigh && canLow) {
          ps.state = containedIdx - 0.5;
          this.applyPulleyConstraint(ps, containedIdx - 1, containedIdx, 1);
        } else if (canHigh) {
          ps.state = containedIdx + 0.5;
          this.applyPulleyConstraint(ps, containedIdx, containedIdx + 1, 1);
        }
        return true;
      }
    }
    return false;
  }

  /** 3D distance from a particle to a world-space point. */
  private particleDistTo(
    idx: number,
    wx: number,
    wy: number,
    wz: number,
  ): number {
    const p = this.particles[idx];
    const dx = p.position[0] - wx;
    const dy = p.position[1] - wy;
    const dz = p.z - wz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Whether a particle can be "contained" (both neighbors exist). */
  private canContain(idx: number): boolean {
    return idx > 0 && idx < this.particles.length - 1;
  }

  /**
   * Update the pulley constraint's particle references and total length.
   *
   * When bodyA's particle changes, shift the ratchet lock by the chain-length
   * delta so the working-length limit `(indexA+1)·link + ratchetDistA` is
   * preserved across the swap. Moving bodyA one particle closer to endpoint A
   * (indexA decreases by 1) loses a link of indexing, so we add a link to
   * ratchetDistA. The opposite direction subtracts.
   */
  private applyPulleyConstraint(
    ps: PulleyState,
    indexA: number,
    indexB: number,
    linkSpan: number,
  ): void {
    const ratchetDelta = (ps.indexA - indexA) * this.chainLinkLength;
    ps.constraint.setParticleA(this.particles[indexA], [0, 0, 0], ratchetDelta);
    ps.constraint.setParticleB(this.particles[indexB], [0, 0, 0]);
    ps.constraint.totalLength = linkSpan * this.chainLinkLength;
    ps.indexA = indexA;
  }

  // ---- Winch: ratcheted pulley ----

  /** Find the index of the first winch, or -1. */
  findWinch(): number {
    return this.winches.length > 0 ? 0 : -1;
  }

  /**
   * Set the winch pulley mode.
   * - "ratchet": rope can slide in (trim) but not out. Default for idle/trimming.
   * - "free": rope slides both ways. Used when easing or releasing.
   */
  setWinchMode(winchIndex: number, mode: PulleyMode): void {
    const ws = this.winches[winchIndex];
    if (!ws) return;
    this.pulleys[ws.pulleyIndex].constraint.setMode(mode);
  }

  /**
   * Apply a tailing force on the tail-side particle to pull rope through
   * the winch. The force is applied in the given world-space direction
   * (typically toward the helm).
   *
   * @param winchIndex Index into the winches array
   * @param forceMagnitude Force strength (positive = pull tail in the given direction)
   * @param dirX World-space X component of the tail direction (unit vector)
   * @param dirY World-space Y component of the tail direction (unit vector)
   */
  applyWinchForce(
    winchIndex: number,
    forceMagnitude: number,
    dirX: number,
    dirY: number,
  ): void {
    const ws = this.winches[winchIndex];
    if (!ws) return;
    const ps = this.pulleys[ws.pulleyIndex];

    // Get the tail-side particle (the one toward the free end / endpoint B)
    const indexB = Number.isInteger(ps.state) ? ps.state + 1 : ps.state + 0.5;
    if (indexB < 0 || indexB >= this.particles.length) return;

    const particle = this.particles[indexB];
    particle.force[0] += dirX * forceMagnitude;
    particle.force[1] += dirY * forceMagnitude;

    // Newton's third law: equal and opposite reaction on the winch body
    const winchBody = ps.body;
    winchBody.force[0] -= dirX * forceMagnitude;
    winchBody.force[1] -= dirY * forceMagnitude;
  }

  /**
   * Get the approximate working length of rope on the sail side of a winch.
   * Computed from the pulley state: number of chain links from endpoint A
   * to the working-side particle.
   */
  getWorkingLength(winchIndex: number): number {
    const ws = this.winches[winchIndex];
    if (!ws) return this.totalLength;
    const ps = this.pulleys[ws.pulleyIndex];

    // The working-side particle index
    const indexA = Number.isInteger(ps.state) ? ps.state - 1 : ps.state - 0.5;
    // Links from endpointA to that particle = indexA + 1
    // Plus a partial link from the particle to the winch
    return (indexA + 1) * this.chainLinkLength + ps.constraint.distA;
  }

  /** Get the current total rope length. */
  getLength(): number {
    return this.totalLength;
  }

  /** Get the chain link length. */
  getChainLinkLength(): number {
    return this.chainLinkLength;
  }

  // ---- Rendering ----

  /**
   * Get world-space rope points with z-values.
   * Includes waypoint positions inserted at the correct chain position
   * so the rope visually routes through blocks/winches.
   */
  getPointsWithZ(): {
    points: [number, number][];
    z: number[];
  } {
    // Fixed topology: always insert each pulley as an extra point between
    // two adjacent particles. This keeps the render point count constant
    // across straddle↔contained mode flips, avoiding geometry snaps.
    //
    // Insertion index ("afterParticle") per pulley:
    // - Straddle (state = K + 0.5): insert after particle K.
    // - Contained (state = K): pick the side via the signed projection of
    //   (p_K − pulley) onto (p_{K+1} − p_{K-1}). If p_K lies toward p_{K+1},
    //   the pulley is "before" p_K → insert after K-1. Otherwise after K.
    //   This flips continuously with particle position (no discrete jump
    //   tied to the mode transition).
    const insertions: {
      afterParticle: number;
      px: number;
      py: number;
      pz: number;
    }[] = [];

    for (const wd of this.waypointData) {
      const ps = this.pulleys[wd.pulleyIndex];
      const [px, py, pz] = wd.body.toWorldFrame3D(
        wd.localAnchor.x,
        wd.localAnchor.y,
        wd.z,
      );
      let afterParticle: number;
      if (!Number.isInteger(ps.state)) {
        afterParticle = ps.state - 0.5;
      } else {
        const k = ps.state;
        // canContain guarantees both neighbors exist for contained mode
        const pk = this.particles[k];
        const pPrev = this.particles[k - 1];
        const pNext = this.particles[k + 1];
        const axisX = pNext.position[0] - pPrev.position[0];
        const axisY = pNext.position[1] - pPrev.position[1];
        const axisZ = pNext.z - pPrev.z;
        const dx = pk.position[0] - px;
        const dy = pk.position[1] - py;
        const dz = pk.z - pz;
        const proj = dx * axisX + dy * axisY + dz * axisZ;
        afterParticle = proj > 0 ? k - 1 : k;
      }
      insertions.push({ afterParticle, px, py, pz });
    }
    insertions.sort((a, b) => a.afterParticle - b.afterParticle);

    let idx = 0;
    let insertIdx = 0;

    // Endpoint A
    const [eax, eay, eaz] = this.endpointA.body.toWorldFrame3D(
      ...this.endpointA.anchor,
    );
    this.cachedPositions[idx][0] = eax;
    this.cachedPositions[idx][1] = eay;
    this.cachedZValues[idx] = eaz;
    idx++;

    // Any pulleys that insert before particle 0 (afterParticle < 0).
    while (
      insertIdx < insertions.length &&
      insertions[insertIdx].afterParticle < 0
    ) {
      const ins = insertions[insertIdx];
      this.cachedPositions[idx][0] = ins.px;
      this.cachedPositions[idx][1] = ins.py;
      this.cachedZValues[idx] = ins.pz;
      idx++;
      insertIdx++;
    }

    // Particles with pulley insertions after each index.
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      this.cachedPositions[idx][0] = p.position[0];
      this.cachedPositions[idx][1] = p.position[1];
      this.cachedZValues[idx] = p.z;
      idx++;

      while (
        insertIdx < insertions.length &&
        insertions[insertIdx].afterParticle === i
      ) {
        const ins = insertions[insertIdx];
        this.cachedPositions[idx][0] = ins.px;
        this.cachedPositions[idx][1] = ins.py;
        this.cachedZValues[idx] = ins.pz;
        idx++;
        insertIdx++;
      }
    }

    // Endpoint B (only if attached)
    if (!this.freeEndB) {
      const [ebx, eby, ebz] = this.endpointB.body.toWorldFrame3D(
        ...this.endpointB.anchor,
      );
      this.cachedPositions[idx][0] = ebx;
      this.cachedPositions[idx][1] = eby;
      this.cachedZValues[idx] = ebz;
    }

    return { points: this.cachedPositions, z: this.cachedZValues };
  }

  // ---- Entity system integration ----

  getParticles(): readonly DynamicBody[] {
    return this.particles;
  }

  getAllConstraints(): readonly Constraint[] {
    const result: Constraint[] = [...this.chainConstraints];
    for (const ps of this.pulleys) result.push(ps.constraint);
    return result;
  }

  isAttached(): boolean {
    return this.attached;
  }

  /** World positions of waypoints (blocks/winches), for rendering block circles. */
  getWaypointPositions(): V2d[] {
    return this.waypointData.map((wd) => wd.body.toWorldFrame(wd.localAnchor));
  }
}
