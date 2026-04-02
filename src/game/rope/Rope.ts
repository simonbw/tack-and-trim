import type { Body } from "../../core/physics/body/Body";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { DistanceConstraint } from "../../core/physics/constraints/DistanceConstraint";
import type { World } from "../../core/physics/world/World";
import { V, V2d } from "../../core/Vector";

export interface RopeConfig {
  /** Number of interior particles (points between the two endpoints). Default 6. */
  particleCount?: number;
  /** Mass of each particle in lbs. Default 0.5. */
  particleMass?: number;
  /** Linear damping on particles (0 = none, 1 = full). Default 0.5. */
  damping?: number;
  /** Constraint stiffness for the GS solver. Default 1e6 (very stiff). */
  constraintStiffness?: number;
  /** Constraint relaxation for the GS solver. Default 4. */
  constraintRelaxation?: number;
}

/**
 * A rope modeled as a chain of lightweight 2D physics particles connected
 * by upper-limit-only distance constraints.
 *
 * The particle positions ARE the rope geometry — no separate visual
 * simulation needed. Constraints transmit forces between the two
 * endpoint bodies (e.g. boom and hull) through the solver.
 *
 * Particles operate in 2D only (x,y). Z-values for rendering are
 * interpolated between the endpoint z-heights — sheets are horizontal
 * so z-physics would only fight the solver.
 */
export class Rope {
  private readonly particles: DynamicBody[] = [];
  private readonly constraints: DistanceConstraint[] = [];

  private readonly bodyA: Body;
  private readonly bodyB: Body;
  private readonly localAnchorA: V2d;
  private readonly localAnchorB: V2d;
  private readonly zA: number;
  private readonly zB: number;
  private readonly particleCount: number;

  private totalLength: number;
  private attached: boolean = false;

  // Pre-allocated output arrays (mutated in place to avoid allocation)
  private readonly cachedPoints: V2d[];
  private readonly cachedPositions: [number, number][];
  private readonly cachedZValues: number[];

  constructor(
    bodyA: Body,
    localAnchorA: [number, number, number],
    bodyB: Body,
    localAnchorB: [number, number, number],
    totalLength: number,
    config: RopeConfig = {},
  ) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    // Store 2D anchors for constraints + z-heights for rendering
    this.localAnchorA = V(localAnchorA[0], localAnchorA[1]);
    this.localAnchorB = V(localAnchorB[0], localAnchorB[1]);
    this.zA = localAnchorA[2];
    this.zB = localAnchorB[2];
    this.totalLength = totalLength;

    this.particleCount = config.particleCount ?? 6;
    const particleMass = config.particleMass ?? 0.5;

    const damping = config.damping ?? 0.5;
    const stiffness = config.constraintStiffness ?? 1e6;
    const relaxation = config.constraintRelaxation ?? 4;

    // Compute initial positions: straight line between 2D endpoints
    const anchorAWorld = bodyA.toWorldFrame(this.localAnchorA);
    const anchorBWorld = bodyB.toWorldFrame(this.localAnchorB);

    // Ensure the rope is long enough to span the current endpoint distance.
    // If the requested length is shorter, clamp up so constraints start
    // satisfied (not immediately taut and yanking the boat around).
    const dx = anchorBWorld[0] - anchorAWorld[0];
    const dy = anchorBWorld[1] - anchorAWorld[1];
    const endpointDist = Math.sqrt(dx * dx + dy * dy);
    if (this.totalLength < endpointDist) {
      this.totalLength = endpointDist;
    }

    // Create interior particles (2D only — no sixDOF).
    // No shape added — particles must not collide with anything (they'd
    // be inside the hull polygon). Shapeless bodies still participate in
    // constraint solving.
    for (let i = 0; i < this.particleCount; i++) {
      const t = (i + 1) / (this.particleCount + 1);
      const particle = new DynamicBody({
        mass: particleMass,
        position: [anchorAWorld[0] + dx * t, anchorAWorld[1] + dy * t],
        fixedRotation: true,
        damping: damping,
        allowSleep: false,
      });
      this.particles.push(particle);
    }

    // Create constraint chain: bodyA → p[0] → p[1] → ... → p[N-1] → bodyB
    const segLen = this.totalLength / (this.particleCount + 1);

    // bodyA → first particle
    this.constraints.push(
      this.makeConstraint(
        bodyA,
        this.localAnchorA,
        this.particles[0],
        V(0, 0),
        segLen,
        stiffness,
        relaxation,
      ),
    );

    // Interior particle-to-particle
    for (let i = 0; i < this.particleCount - 1; i++) {
      this.constraints.push(
        this.makeConstraint(
          this.particles[i],
          V(0, 0),
          this.particles[i + 1],
          V(0, 0),
          segLen,
          stiffness,
          relaxation,
        ),
      );
    }

    // Last particle → bodyB
    this.constraints.push(
      this.makeConstraint(
        this.particles[this.particleCount - 1],
        V(0, 0),
        bodyB,
        this.localAnchorB,
        segLen,
        stiffness,
        relaxation,
      ),
    );

    // Pre-allocate output arrays (particleCount + 2 total: both endpoints + particles)
    const totalPoints = this.particleCount + 2;
    this.cachedPoints = Array.from({ length: totalPoints }, () => V(0, 0));
    this.cachedPositions = Array.from(
      { length: totalPoints },
      () => [0, 0] as [number, number],
    );
    this.cachedZValues = new Array(totalPoints).fill(0);
  }

  private makeConstraint(
    a: Body,
    anchorA: V2d,
    b: Body,
    anchorB: V2d,
    segLen: number,
    stiffness: number,
    relaxation: number,
  ): DistanceConstraint {
    const c = new DistanceConstraint(a, b, {
      localAnchorA: anchorA,
      localAnchorB: anchorB,
      distance: segLen,
      collideConnected: false,
    });
    c.upperLimitEnabled = true;
    c.lowerLimitEnabled = false;
    c.upperLimit = segLen;
    for (const eq of c.equations) {
      eq.stiffness = stiffness;
      eq.relaxation = relaxation;
    }
    return c;
  }

  /** Add all particles and constraints to the physics world. */
  attach(world: World): void {
    if (this.attached) return;
    for (const p of this.particles) {
      world.bodies.add(p);
    }
    for (const c of this.constraints) {
      world.constraints.add(c);
    }
    this.attached = true;
  }

  /** Remove all particles and constraints from the physics world. */
  detach(world: World): void {
    if (!this.attached) return;
    for (const c of this.constraints) {
      world.constraints.remove(c);
    }
    for (const p of this.particles) {
      world.bodies.remove(p);
    }
    this.attached = false;
  }

  /** Per-tick update. Currently a no-op (no gravity on 2D particles). */
  tick(): void {
    // No gravity — 2D sheet particles don't need z-forces.
    // Sag comes from constraint slack when rope is longer than
    // the endpoint distance. Inertia and damping handle the rest.
  }

  /**
   * Update the total rope length. Distributes evenly across all segment
   * constraints by updating their upper limits.
   */
  setLength(length: number): void {
    this.totalLength = length;
    const segLen = Math.max(0.01, length / (this.particleCount + 1));
    for (const c of this.constraints) {
      c.upperLimit = segLen;
      c.distance = segLen;
    }
  }

  /**
   * Release the rope to guaranteed slack. Sets length to at least the
   * current endpoint distance so no constraints are violated.
   */
  releaseToSlack(minLength: number): void {
    const anchorA = this.bodyA.toWorldFrame(this.localAnchorA);
    const anchorB = this.bodyB.toWorldFrame(this.localAnchorB);
    const dx = anchorB[0] - anchorA[0];
    const dy = anchorB[1] - anchorA[1];
    const endpointDist = Math.sqrt(dx * dx + dy * dy);
    this.setLength(Math.max(minLength, endpointDist));
  }

  /** Get the current total rope length. */
  getLength(): number {
    return this.totalLength;
  }

  /**
   * Get world-space rope points: [bodyA anchor, ...particles, bodyB anchor].
   * Returns a cached array of V2d — do not hold references across frames.
   */
  getPoints(): readonly V2d[] {
    const anchorA = this.bodyA.toWorldFrame(this.localAnchorA);
    this.cachedPoints[0].x = anchorA[0];
    this.cachedPoints[0].y = anchorA[1];

    for (let i = 0; i < this.particleCount; i++) {
      const pos = this.particles[i].position;
      this.cachedPoints[i + 1].x = pos[0];
      this.cachedPoints[i + 1].y = pos[1];
    }

    const last = this.particleCount + 1;
    const anchorB = this.bodyB.toWorldFrame(this.localAnchorB);
    this.cachedPoints[last].x = anchorB[0];
    this.cachedPoints[last].y = anchorB[1];

    return this.cachedPoints;
  }

  /**
   * Get world-space rope points with z-values interpolated between
   * endpoint z-heights. Z is for rendering parallax only — particles
   * don't simulate in z.
   */
  getPointsWithZ(): {
    points: [number, number][];
    z: number[];
  } {
    const anchorA = this.bodyA.toWorldFrame(this.localAnchorA);
    this.cachedPositions[0][0] = anchorA[0];
    this.cachedPositions[0][1] = anchorA[1];
    this.cachedZValues[0] = this.zA;

    const totalPoints = this.particleCount + 2;
    for (let i = 0; i < this.particleCount; i++) {
      const p = this.particles[i];
      this.cachedPositions[i + 1][0] = p.position[0];
      this.cachedPositions[i + 1][1] = p.position[1];
      this.cachedZValues[i + 1] =
        this.zA + (this.zB - this.zA) * ((i + 1) / (totalPoints - 1));
    }

    const last = this.particleCount + 1;
    const anchorB = this.bodyB.toWorldFrame(this.localAnchorB);
    this.cachedPositions[last][0] = anchorB[0];
    this.cachedPositions[last][1] = anchorB[1];
    this.cachedZValues[last] = this.zB;

    return { points: this.cachedPositions, z: this.cachedZValues };
  }

  /** Whether the rope is currently attached to a physics world. */
  isAttached(): boolean {
    return this.attached;
  }

  /** The interior particle bodies (for debugging or future block integration). */
  getParticles(): readonly DynamicBody[] {
    return this.particles;
  }

  /** The constraint chain (for debugging or future block integration). */
  getConstraints(): readonly DistanceConstraint[] {
    return this.constraints;
  }
}
