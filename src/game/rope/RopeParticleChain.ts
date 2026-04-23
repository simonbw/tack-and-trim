/**
 * Visual-only particle chain for one rope section.
 *
 * Verlet integration plus a position-based distance constraint between
 * neighbouring particles, with the two endpoints pinned (zero inverse mass)
 * to whatever world positions the owning RopeRender feeds in each tick.
 * Gravity makes the chain droop; the constraint keeps total length close to
 * the section's current rest length.
 *
 * No coupling back into RopeNetwork — this is decoration. The capstan solver
 * remains the authority on per-section length and tension.
 */

const GRAVITY = 32.2;

/** Per-tick velocity retention (Verlet damping). 1 = none, 0 = total. */
const DAMPING = 0.94;

/** Default PBD constraint solve passes per tick. Higher = stiffer chain. */
const DEFAULT_ITERATIONS = 6;

/**
 * Floor query: given a world-space sample at (x, y, z), returns the minimum
 * allowed world z, or -Infinity for "no floor here". The current z is
 * required because the floor is anchored to a body that may be tilted in
 * 3D, so the hull-local lookup point depends on z.
 */
export type FloorFn = (x: number, y: number, z: number) => number;

/**
 * Reference-frame velocity query: fills `out` with the world-frame velocity
 * of the damping reference (typically the hull at the particle's world
 * position — linear + angular contribution). Damping pulls particle motion
 * toward this velocity rather than toward zero world velocity, so a rope on
 * a moving boat rides with the boat instead of lagging behind it.
 */
export type ReferenceVelocityFn = (
  x: number,
  y: number,
  z: number,
  out: Float64Array,
) => void;

export class RopeParticleChain {
  /** Number of particles, including the two pinned endpoints. */
  readonly count: number;
  /** Flattened positions [x0,y0,z0,x1,y1,z1,…]. */
  readonly pos: Float64Array;
  /** PBD constraint solve passes per tick. Higher = stiffer / straighter chain. */
  iterations: number;
  /**
   * Gravity scale factor. 1 = full gravity (sheet/anchor catenary droop).
   * 0 = no gravity — useful for ropes under load (halyards) that should
   * read as taut lines rather than catenaries. Values between 0 and 1
   * model partial tension.
   */
  gravityScale: number;
  /** Flattened previous-tick positions (Verlet). */
  private readonly prev: Float64Array;
  /** Per-particle inverse mass; 0 = pinned. */
  private readonly invMass: Float64Array;
  /** Scratch vector for reference-frame velocity sampling. */
  private readonly refVelScratch: Float64Array = new Float64Array(3);

  constructor(
    count: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    sectionLength: number,
    iterations: number = DEFAULT_ITERATIONS,
    gravityScale: number = 1,
  ) {
    if (count < 2) throw new Error("Particle chain needs >= 2 particles");
    this.count = count;
    this.iterations = iterations;
    this.gravityScale = gravityScale;
    this.pos = new Float64Array(count * 3);
    this.prev = new Float64Array(count * 3);
    this.invMass = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      this.invMass[i] = i === 0 || i === count - 1 ? 0 : 1;
    }
    this.seed(ax, ay, az, bx, by, bz, sectionLength);
  }

  /**
   * Place particles along the chord with a parabolic sag matching the
   * section's current slack. Used at construction and on hard re-init.
   */
  seed(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    sectionLength: number,
  ): void {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const slack = Math.max(0, sectionLength - chord);
    let sagMag = chord > 1e-6 ? Math.sqrt((3 * chord * slack) / 8) : 0;
    if (sagMag > chord * 1.2) sagMag = chord * 1.2;
    for (let i = 0; i < this.count; i++) {
      const t = i / (this.count - 1);
      const px = ax + dx * t;
      const py = ay + dy * t;
      const pz = az + dz * t - sagMag * 4 * t * (1 - t);
      const o = i * 3;
      this.pos[o] = px;
      this.pos[o + 1] = py;
      this.pos[o + 2] = pz;
      this.prev[o] = px;
      this.prev[o + 1] = py;
      this.prev[o + 2] = pz;
    }
  }

  /**
   * Pin the two endpoints to the supplied world positions. Resets prev to
   * pos for the endpoints so they don't accumulate spurious velocity from
   * being teleported with the rigid body each tick.
   */
  setEndpoints(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
  ): void {
    this.pos[0] = ax;
    this.pos[1] = ay;
    this.pos[2] = az;
    this.prev[0] = ax;
    this.prev[1] = ay;
    this.prev[2] = az;
    const last = (this.count - 1) * 3;
    this.pos[last] = bx;
    this.pos[last + 1] = by;
    this.pos[last + 2] = bz;
    this.prev[last] = bx;
    this.prev[last + 1] = by;
    this.prev[last + 2] = bz;
  }

  /**
   * Verlet integrate, then run distance + floor constraint passes.
   *
   * @param sectionLength current rest length (ft) — chain target arc length.
   * @param dt timestep (s).
   * @param floorAt optional world (x,y,z) → min-z floor (e.g., deck surface).
   * @param refVelAt optional reference-frame velocity (e.g., hull velocity
   *   at the particle's world position). Damping pulls particle motion
   *   toward this velocity rather than toward zero world velocity, so a
   *   rope on a moving boat rides with the boat.
   */
  update(
    sectionLength: number,
    dt: number,
    floorAt: FloorFn | null,
    refVelAt: ReferenceVelocityFn | null,
  ): void {
    const N = this.count;
    const restSeg = sectionLength / (N - 1);
    const gdt2 = GRAVITY * dt * dt * this.gravityScale;
    const ref = this.refVelScratch;

    // Verlet step on interior particles only; endpoints are held by setEndpoints.
    for (let i = 1; i < N - 1; i++) {
      const o = i * 3;
      const px = this.pos[o];
      const py = this.pos[o + 1];
      const pz = this.pos[o + 2];
      // Damp displacement toward the reference frame's displacement over
      // this tick. With refVel = 0 this reduces to the usual world-frame
      // damping (velocity * DAMPING).
      let refDx = 0;
      let refDy = 0;
      let refDz = 0;
      if (refVelAt) {
        refVelAt(px, py, pz, ref);
        refDx = ref[0] * dt;
        refDy = ref[1] * dt;
        refDz = ref[2] * dt;
      }
      const dx = (px - this.prev[o] - refDx) * DAMPING + refDx;
      const dy = (py - this.prev[o + 1] - refDy) * DAMPING + refDy;
      const dz = (pz - this.prev[o + 2] - refDz) * DAMPING + refDz;
      this.prev[o] = px;
      this.prev[o + 1] = py;
      this.prev[o + 2] = pz;
      this.pos[o] = px + dx;
      this.pos[o + 1] = py + dy;
      this.pos[o + 2] = pz + dz - gdt2;
    }

    for (let iter = 0; iter < this.iterations; iter++) {
      // Distance constraints, Gauss-Seidel pass forward then backward so
      // the chain can equilibrate from both anchor ends in the same iteration.
      this.solveDistancesForward(restSeg);
      this.solveDistancesBackward(restSeg);
      if (floorAt) this.projectFloor(floorAt);
    }
  }

  private solveDistancesForward(restSeg: number): void {
    const N = this.count;
    for (let i = 0; i < N - 1; i++) this.solveDistanceConstraint(i, restSeg);
  }

  private solveDistancesBackward(restSeg: number): void {
    for (let i = this.count - 2; i >= 0; i--) {
      this.solveDistanceConstraint(i, restSeg);
    }
  }

  private solveDistanceConstraint(i: number, restSeg: number): void {
    const oA = i * 3;
    const oB = oA + 3;
    const wA = this.invMass[i];
    const wB = this.invMass[i + 1];
    const sumW = wA + wB;
    if (sumW <= 0) return;
    const dx = this.pos[oB] - this.pos[oA];
    const dy = this.pos[oB + 1] - this.pos[oA + 1];
    const dz = this.pos[oB + 2] - this.pos[oA + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-12) return;
    const d = Math.sqrt(d2);
    const corr = (d - restSeg) / (d * sumW);
    const cx = dx * corr;
    const cy = dy * corr;
    const cz = dz * corr;
    this.pos[oA] += cx * wA;
    this.pos[oA + 1] += cy * wA;
    this.pos[oA + 2] += cz * wA;
    this.pos[oB] -= cx * wB;
    this.pos[oB + 1] -= cy * wB;
    this.pos[oB + 2] -= cz * wB;
  }

  private projectFloor(floorAt: FloorFn): void {
    const N = this.count;
    for (let i = 1; i < N - 1; i++) {
      const o = i * 3;
      const floor = floorAt(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      if (!isFinite(floor)) continue;
      if (this.pos[o + 2] < floor) {
        const dz = floor - this.pos[o + 2];
        this.pos[o + 2] = floor;
        // Lift prev z by the same amount so the next Verlet step sees no
        // residual downward velocity at the contact — rope settles instead
        // of bouncing.
        this.prev[o + 2] += dz;
      }
    }
  }
}
