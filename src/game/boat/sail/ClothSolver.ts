/**
 * 3D Verlet cloth solver for sail simulation.
 * Pre-allocated typed arrays, zero allocation after warmup.
 * Does NOT use the physics engine.
 *
 * Each vertex has a full 3D position (x, y, z). Constraints operate on
 * 3D distances, so the sail has structural integrity in all directions:
 * the foot spans x,y along the boom, the luff spans z up the mast, and
 * wind pushes the sail perpendicular in x,y creating billow.
 */

import type { SailMeshData } from "./SailMesh";

export interface ClothSolverConfig {
  /** dimensionless (0-1), Verlet velocity retention per step. 1.0 = no damping,
   *  0.0 = full damping. Typical 0.95-1.0. Controls overall cloth motion damping. */
  damping: number;
  /** count, number of constraint projection iterations per simulation step.
   *  Higher = stiffer cloth but more expensive. Typical 5-20. */
  constraintIterations: number;
  /** dimensionless (0-1), correction factor for bend (skip-one) constraints.
   *  0 = no bend resistance, 1 = rigid. Typical 0.1-0.5. Controls how much the
   *  cloth resists bending between non-adjacent vertices. */
  bendStiffness: number;
  /** dimensionless (0-1), damping of relative velocity along constraint directions.
   *  Acts like a dashpot in parallel with each distance constraint to reduce oscillation.
   *  Typical 0.02-0.2. */
  constraintDamping: number;
}

export class ClothSolver {
  readonly vertexCount: number;

  // Simulation state — all 3D, stored as x,y,z triples
  private readonly positions: Float64Array; // 3 * vertexCount
  private readonly prevPositions: Float64Array; // 3 * vertexCount
  private readonly forces: Float64Array; // 3 * vertexCount (fx, fy, fz)
  private readonly pinned: Uint8Array;
  private readonly pinTargets: Float64Array; // 3 * vertexCount (tx, ty, tz)
  private readonly skipped: Uint8Array; // 1 = vertex excluded from simulation entirely

  // Reaction forces on pinned vertices
  private readonly reactionForces: Float64Array; // 3 * vertexCount

  // Constraints (stored as flat arrays for cache efficiency)
  private readonly structA: Int32Array;
  private readonly structB: Int32Array;
  private readonly structRest: Float64Array;
  private readonly shearA: Int32Array;
  private readonly shearB: Int32Array;
  private readonly shearRest: Float64Array;
  private readonly bendA: Int32Array;
  private readonly bendB: Int32Array;
  private readonly bendRest: Float64Array;

  private readonly damping: number;
  private readonly bendStiffness: number;
  private constraintDamping: number;

  constructor(mesh: SailMeshData, config: ClothSolverConfig) {
    this.vertexCount = mesh.vertexCount;
    this.damping = config.damping;
    this.bendStiffness = config.bendStiffness;
    this.constraintDamping = config.constraintDamping;

    const n = mesh.vertexCount;

    this.positions = new Float64Array(n * 3);
    this.prevPositions = new Float64Array(n * 3);
    this.forces = new Float64Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.pinTargets = new Float64Array(n * 3);
    this.skipped = new Uint8Array(n);
    this.reactionForces = new Float64Array(n * 3);

    // Pack constraints into flat arrays
    const pack = (
      src: [number, number, number][],
    ): { a: Int32Array; b: Int32Array; rest: Float64Array } => {
      const a = new Int32Array(src.length);
      const b = new Int32Array(src.length);
      const rest = new Float64Array(src.length);
      for (let i = 0; i < src.length; i++) {
        a[i] = src[i][0];
        b[i] = src[i][1];
        rest[i] = src[i][2]; // UV rest lengths — will be recomputed after init
      }
      return { a, b, rest };
    };

    const sc = pack(mesh.structuralConstraints);
    this.structA = sc.a;
    this.structB = sc.b;
    this.structRest = sc.rest;

    const sh = pack(mesh.shearConstraints);
    this.shearA = sh.a;
    this.shearB = sh.b;
    this.shearRest = sh.rest;

    const bc = pack(mesh.bendConstraints);
    this.bendA = bc.a;
    this.bendB = bc.b;
    this.bendRest = bc.rest;
  }

  /**
   * Construct a ClothSolver from a snapshot (for use in workers).
   * The snapshot provides pre-computed arrays so no SailMeshData is needed.
   */
  static fromSnapshot(
    snapshot: ReturnType<ClothSolver["snapshotState"]> & {
      vertexCount: number;
    },
  ): ClothSolver {
    // Create a minimal mesh-like object just to satisfy the constructor
    const dummy: SailMeshData = {
      vertexCount: snapshot.vertexCount,
      restPositions: new Float64Array(0),
      zHeights: new Float64Array(0),
      indices: [],
      structuralConstraints: [],
      shearConstraints: [],
      bendConstraints: [],
      luffVertices: [],
      footVertices: [],
      leechVertices: [],
      rowStarts: [],
      colCounts: [],
    };
    const solver = new ClothSolver(dummy, {
      damping: snapshot.damping,
      constraintIterations: 0,
      bendStiffness: snapshot.bendStiffness,
      constraintDamping: snapshot.constraintDamping,
    });
    // Overwrite the arrays with the snapshot data
    (solver as any).positions.set(snapshot.positions);
    (solver as any).prevPositions.set(snapshot.prevPositions);
    (solver as any).pinned.set(snapshot.pinned);
    (solver as any).pinTargets.set(snapshot.pinTargets);
    if (snapshot.skipped) (solver as any).skipped.set(snapshot.skipped);
    (solver as any).structA = snapshot.structA;
    (solver as any).structB = snapshot.structB;
    (solver as any).structRest = snapshot.structRest;
    (solver as any).shearA = snapshot.shearA;
    (solver as any).shearB = snapshot.shearB;
    (solver as any).shearRest = snapshot.shearRest;
    (solver as any).bendA = snapshot.bendA;
    (solver as any).bendB = snapshot.bendB;
    (solver as any).bendRest = snapshot.bendRest;
    return solver;
  }

  /**
   * Initialize all 3D positions. Call once after construction.
   * Recomputes constraint rest lengths from 3D distances.
   */
  initializePositions(
    worldX: Float64Array,
    worldY: Float64Array,
    worldZ: Float64Array,
  ): void {
    for (let i = 0; i < this.vertexCount; i++) {
      const i3 = i * 3;
      this.positions[i3] = worldX[i];
      this.positions[i3 + 1] = worldY[i];
      this.positions[i3 + 2] = worldZ[i];
      this.prevPositions[i3] = worldX[i];
      this.prevPositions[i3 + 1] = worldY[i];
      this.prevPositions[i3 + 2] = worldZ[i];
    }
    this.recomputeRestLengths();
  }

  /**
   * Set all positions without recomputing rest lengths.
   * Use after initializePositions to move vertices to a different starting
   * state while keeping the rest lengths from the original shape.
   */
  resetPositions(
    worldX: Float64Array,
    worldY: Float64Array,
    worldZ: Float64Array,
  ): void {
    for (let i = 0; i < this.vertexCount; i++) {
      const i3 = i * 3;
      this.positions[i3] = worldX[i];
      this.positions[i3 + 1] = worldY[i];
      this.positions[i3 + 2] = worldZ[i];
      this.prevPositions[i3] = worldX[i];
      this.prevPositions[i3 + 1] = worldY[i];
      this.prevPositions[i3 + 2] = worldZ[i];
    }
  }

  /** Recompute all constraint rest lengths from current 3D positions. */
  private recomputeRestLengths(): void {
    const pos = this.positions;
    const recompute = (
      aArr: Int32Array,
      bArr: Int32Array,
      restArr: Float64Array,
    ) => {
      for (let c = 0; c < aArr.length; c++) {
        const a3 = aArr[c] * 3;
        const b3 = bArr[c] * 3;
        const dx = pos[b3] - pos[a3];
        const dy = pos[b3 + 1] - pos[a3 + 1];
        const dz = pos[b3 + 2] - pos[a3 + 2];
        restArr[c] = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    };
    recompute(this.structA, this.structB, this.structRest);
    recompute(this.shearA, this.shearB, this.shearRest);
    recompute(this.bendA, this.bendB, this.bendRest);
  }

  /** Clear force accumulators. */
  clearForces(): void {
    this.forces.fill(0);
  }

  /** Accumulate force on a vertex. */
  applyForce(index: number, fx: number, fy: number, fz: number): void {
    const i3 = index * 3;
    this.forces[i3] += fx;
    this.forces[i3 + 1] += fy;
    this.forces[i3 + 2] += fz;
  }

  /** Set pin target for a vertex. */
  setPinTarget(index: number, x: number, y: number, z: number): void {
    const i3 = index * 3;
    this.pinTargets[i3] = x;
    this.pinTargets[i3 + 1] = y;
    this.pinTargets[i3 + 2] = z;
  }

  /** Toggle pinning for a vertex. */
  setPinned(index: number, pinned: boolean): void {
    this.pinned[index] = pinned ? 1 : 0;
  }

  /** Update constraint damping coefficient at runtime. */
  setConstraintDamping(value: number): void {
    this.constraintDamping = value;
  }

  /** Mark a vertex as skipped (excluded from simulation entirely). */
  setSkipped(index: number, skip: boolean): void {
    this.skipped[index] = skip ? 1 : 0;
  }

  /**
   * Snapshot solver state for transfer to a worker.
   * Returns copies of internal arrays for one-time transfer.
   */
  snapshotState(): {
    positions: Float64Array;
    prevPositions: Float64Array;
    pinned: Uint8Array;
    pinTargets: Float64Array;
    skipped: Uint8Array;
    structA: Int32Array;
    structB: Int32Array;
    structRest: Float64Array;
    shearA: Int32Array;
    shearB: Int32Array;
    shearRest: Float64Array;
    bendA: Int32Array;
    bendB: Int32Array;
    bendRest: Float64Array;
    damping: number;
    bendStiffness: number;
    constraintDamping: number;
  } {
    return {
      positions: new Float64Array(this.positions),
      prevPositions: new Float64Array(this.prevPositions),
      pinned: new Uint8Array(this.pinned),
      pinTargets: new Float64Array(this.pinTargets),
      skipped: new Uint8Array(this.skipped),
      structA: new Int32Array(this.structA),
      structB: new Int32Array(this.structB),
      structRest: new Float64Array(this.structRest),
      shearA: new Int32Array(this.shearA),
      shearB: new Int32Array(this.shearB),
      shearRest: new Float64Array(this.shearRest),
      bendA: new Int32Array(this.bendA),
      bendB: new Int32Array(this.bendB),
      bendRest: new Float64Array(this.bendRest),
      damping: this.damping,
      bendStiffness: this.bendStiffness,
      constraintDamping: this.constraintDamping,
    };
  }

  getPositionX(index: number): number {
    return this.positions[index * 3];
  }
  getPositionY(index: number): number {
    return this.positions[index * 3 + 1];
  }
  getZ(index: number): number {
    return this.positions[index * 3 + 2];
  }

  getPrevPositionX(index: number): number {
    return this.prevPositions[index * 3];
  }
  getPrevPositionY(index: number): number {
    return this.prevPositions[index * 3 + 1];
  }

  getReactionForceX(index: number): number {
    return this.reactionForces[index * 3];
  }
  getReactionForceY(index: number): number {
    return this.reactionForces[index * 3 + 1];
  }
  getReactionForceZ(index: number): number {
    return this.reactionForces[index * 3 + 2];
  }

  /** Sum reaction forces for a set of vertex indices. Returns [fx, fy, fz]. */
  sumReactionForces(indices: number[]): [number, number, number] {
    let fx = 0,
      fy = 0,
      fz = 0;
    for (const i of indices) {
      const i3 = i * 3;
      fx += this.reactionForces[i3];
      fy += this.reactionForces[i3 + 1];
      fz += this.reactionForces[i3 + 2];
    }
    return [fx, fy, fz];
  }

  /**
   * Run one simulation step.
   * External code should call clearForces(), applyForce(), setPinTarget() before this.
   */
  update(dt: number, constraintIterations: number): void {
    const dtSq = dt * dt;
    const invDtSq = dtSq > 0 ? 1 / dtSq : 0;
    const n = this.vertexCount;
    const pos = this.positions;
    const prev = this.prevPositions;
    const forces = this.forces;
    const pinned = this.pinned;
    const skipped = this.skipped;
    const damping = this.damping;
    const reactions = this.reactionForces;

    // Reaction forces on pinned vertices have two components:
    // 1. External forces (gravity, wind) applied directly to the vertex
    // 2. Constraint corrections from neighboring vertices pulling on it
    // Start at zero; constraint displacement is accumulated during solving,
    // then converted to force and combined with external forces at the end.
    reactions.fill(0);

    // Verlet integration for free vertices — all 3 axes
    for (let i = 0; i < n; i++) {
      if (pinned[i] || skipped[i]) continue;

      const i3 = i * 3;
      const vx = (pos[i3] - prev[i3]) * damping;
      const vy = (pos[i3 + 1] - prev[i3 + 1]) * damping;
      const vz = (pos[i3 + 2] - prev[i3 + 2]) * damping;

      prev[i3] = pos[i3];
      prev[i3 + 1] = pos[i3 + 1];
      prev[i3 + 2] = pos[i3 + 2];

      pos[i3] += vx + forces[i3] * dtSq;
      pos[i3 + 1] += vy + forces[i3 + 1] * dtSq;
      pos[i3 + 2] += vz + forces[i3 + 2] * dtSq;
    }

    // Check for explosion
    if (this.checkExplosion()) {
      return;
    }

    // Pin vertices to targets
    this.applyPins();

    // Constraint projection — 3D distances
    // solveConstraints accumulates displacement into reactionForces for pinned vertices
    for (let iter = 0; iter < constraintIterations; iter++) {
      this.solveConstraints(this.structA, this.structB, this.structRest, 0.5);
      this.solveConstraints(this.shearA, this.shearB, this.shearRest, 0.5);
      this.solveConstraints(
        this.bendA,
        this.bendB,
        this.bendRest,
        0.5 * this.bendStiffness,
      );
      this.applyPins();
    }

    // Convert constraint displacement to force, add external forces.
    // reactions = externalForces + constraintDisplacement / dt²
    for (let i = 0; i < n; i++) {
      if (!pinned[i] || skipped[i]) continue;
      const i3 = i * 3;
      reactions[i3] = forces[i3] + reactions[i3] * invDtSq;
      reactions[i3 + 1] = forces[i3 + 1] + reactions[i3 + 1] * invDtSq;
      reactions[i3 + 2] = forces[i3 + 2] + reactions[i3 + 2] * invDtSq;
    }
  }

  private static readonly EXPLOSION_RADIUS = 200;
  private explosionLogged = false;

  private checkExplosion(): boolean {
    const pos = this.positions;
    const pinned = this.pinned;
    const n = this.vertexCount;

    let cx = 0,
      cy = 0,
      cz = 0,
      pinCount = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        const i3 = i * 3;
        cx += this.pinTargets[i3];
        cy += this.pinTargets[i3 + 1];
        cz += this.pinTargets[i3 + 2];
        pinCount++;
      }
    }
    if (pinCount === 0) return false;
    cx /= pinCount;
    cy /= pinCount;
    cz /= pinCount;

    const maxR2 = ClothSolver.EXPLOSION_RADIUS * ClothSolver.EXPLOSION_RADIUS;

    for (let i = 0; i < n; i++) {
      if (pinned[i] || this.skipped[i]) continue;
      const i3 = i * 3;
      const dx = pos[i3] - cx;
      const dy = pos[i3 + 1] - cy;
      const dz = pos[i3 + 2] - cz;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (
        r2 > maxR2 ||
        !isFinite(pos[i3]) ||
        !isFinite(pos[i3 + 1]) ||
        !isFinite(pos[i3 + 2])
      ) {
        if (!this.explosionLogged) {
          console.error(
            `[ClothSolver] Cloth exploded — vertex ${i} is ${Math.sqrt(r2).toFixed(0)}ft from centroid. Resetting.`,
          );
          this.explosionLogged = true;
        }
        this.resetToPin();
        return true;
      }
    }

    this.explosionLogged = false;
    return false;
  }

  resetToPin(): void {
    const n = this.vertexCount;
    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) {
        const i3 = i * 3;
        this.positions[i3] = this.pinTargets[i3];
        this.positions[i3 + 1] = this.pinTargets[i3 + 1];
        this.positions[i3 + 2] = this.pinTargets[i3 + 2];
        this.prevPositions[i3] = this.pinTargets[i3];
        this.prevPositions[i3 + 1] = this.pinTargets[i3 + 1];
        this.prevPositions[i3 + 2] = this.pinTargets[i3 + 2];
      }
    }

    let cx = 0,
      cy = 0,
      cz = 0,
      count = 0;
    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) {
        const i3 = i * 3;
        cx += this.pinTargets[i3];
        cy += this.pinTargets[i3 + 1];
        cz += this.pinTargets[i3 + 2];
        count++;
      }
    }
    if (count > 0) {
      cx /= count;
      cy /= count;
      cz /= count;
    }

    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) continue;
      const i3 = i * 3;
      this.positions[i3] = cx;
      this.positions[i3 + 1] = cy;
      this.positions[i3 + 2] = cz;
      this.prevPositions[i3] = cx;
      this.prevPositions[i3 + 1] = cy;
      this.prevPositions[i3 + 2] = cz;
    }

    this.reactionForces.fill(0);
  }

  /**
   * 3D constraint projection.
   * When one end is pinned, the full correction goes to the free end.
   * The displacement the pinned end resisted is accumulated into reactionForces
   * (in displacement units — converted to force after all iterations).
   */
  private solveConstraints(
    aArr: Int32Array,
    bArr: Int32Array,
    restArr: Float64Array,
    correctionFactor: number,
  ): void {
    const pos = this.positions;
    const prev = this.prevPositions;
    const pinned = this.pinned;
    const skipped = this.skipped;
    const reactions = this.reactionForces;
    const cDamp = this.constraintDamping;
    const count = aArr.length;

    for (let c = 0; c < count; c++) {
      const a = aArr[c];
      const b = bArr[c];

      // Skip constraints involving skipped (excluded) vertices
      if (skipped[a] || skipped[b]) continue;

      const rest = restArr[c];

      const a3 = a * 3;
      const b3 = b * 3;

      const dx = pos[b3] - pos[a3];
      const dy = pos[b3 + 1] - pos[a3 + 1];
      const dz = pos[b3 + 2] - pos[a3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.0001) continue;

      const invDist = 1 / dist;

      // Position correction (spring)
      const error = (dist - rest) * correctionFactor * invDist;
      let ex = dx * error;
      let ey = dy * error;
      let ez = dz * error;

      // Constraint damping: damp relative velocity along the constraint direction.
      // Like a dashpot in parallel with the spring — targets oscillation
      // without damping overall cloth motion.
      if (cDamp > 0) {
        // Relative velocity (in displacement units: pos - prev)
        const dvx = pos[b3] - prev[b3] - (pos[a3] - prev[a3]);
        const dvy = pos[b3 + 1] - prev[b3 + 1] - (pos[a3 + 1] - prev[a3 + 1]);
        const dvz = pos[b3 + 2] - prev[b3 + 2] - (pos[a3 + 2] - prev[a3 + 2]);

        // Project onto constraint direction
        const relVel = (dvx * dx + dvy * dy + dvz * dz) * invDist;

        // Add damping correction along constraint direction
        const dampCorr = relVel * cDamp * invDist;
        ex += dx * dampCorr;
        ey += dy * dampCorr;
        ez += dz * dampCorr;
      }

      const aPin = pinned[a];
      const bPin = pinned[b];

      if (aPin && bPin) continue;
      if (aPin) {
        pos[b3] -= ex;
        pos[b3 + 1] -= ey;
        pos[b3 + 2] -= ez;
        // The constraint pulls A toward B by (ex, ey, ez); pin absorbs it
        reactions[a3] += ex;
        reactions[a3 + 1] += ey;
        reactions[a3 + 2] += ez;
      } else if (bPin) {
        pos[a3] += ex;
        pos[a3 + 1] += ey;
        pos[a3 + 2] += ez;
        // The constraint pulls B toward A by (-ex, -ey, -ez); pin absorbs it
        reactions[b3] -= ex;
        reactions[b3 + 1] -= ey;
        reactions[b3 + 2] -= ez;
      } else {
        pos[a3] += ex * 0.5;
        pos[a3 + 1] += ey * 0.5;
        pos[a3 + 2] += ez * 0.5;
        pos[b3] -= ex * 0.5;
        pos[b3 + 1] -= ey * 0.5;
        pos[b3 + 2] -= ez * 0.5;
      }
    }
  }

  private applyPins(): void {
    const pos = this.positions;
    const prev = this.prevPositions;
    const pinned = this.pinned;
    const skipped = this.skipped;
    const targets = this.pinTargets;

    for (let i = 0; i < this.vertexCount; i++) {
      if (!pinned[i] || skipped[i]) continue;
      const i3 = i * 3;
      pos[i3] = targets[i3];
      pos[i3 + 1] = targets[i3 + 1];
      pos[i3 + 2] = targets[i3 + 2];
      prev[i3] = targets[i3];
      prev[i3 + 1] = targets[i3 + 1];
      prev[i3 + 2] = targets[i3 + 2];
    }
  }
}
