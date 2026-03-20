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
  damping: number; // velocity damping (0-1), e.g. 0.97
  constraintIterations: number; // e.g. 5
  bendStiffness: number; // 0-1 correction factor for bend constraints, e.g. 0.3
}

export class ClothSolver {
  readonly vertexCount: number;

  // Simulation state — all 3D, stored as x,y,z triples
  private readonly positions: Float64Array; // 3 * vertexCount
  private readonly prevPositions: Float64Array; // 3 * vertexCount
  private readonly forces: Float64Array; // 3 * vertexCount (fx, fy, fz)
  private readonly pinned: Uint8Array;
  private readonly pinTargets: Float64Array; // 3 * vertexCount (tx, ty, tz)

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
  private readonly constraintIterations: number;
  private readonly bendStiffness: number;

  constructor(mesh: SailMeshData, config: ClothSolverConfig) {
    this.vertexCount = mesh.vertexCount;
    this.damping = config.damping;
    this.constraintIterations = config.constraintIterations;
    this.bendStiffness = config.bendStiffness;

    const n = mesh.vertexCount;

    this.positions = new Float64Array(n * 3);
    this.prevPositions = new Float64Array(n * 3);
    this.forces = new Float64Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.pinTargets = new Float64Array(n * 3);
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
  update(dt: number): void {
    const dtSq = dt * dt;
    const invDtSq = dtSq > 0 ? 1 / dtSq : 0;
    const n = this.vertexCount;
    const pos = this.positions;
    const prev = this.prevPositions;
    const forces = this.forces;
    const pinned = this.pinned;
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
      if (pinned[i]) continue;

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
    for (let iter = 0; iter < this.constraintIterations; iter++) {
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
      if (!pinned[i]) continue;
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
      if (pinned[i]) continue;
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
    const pinned = this.pinned;
    const reactions = this.reactionForces;
    const count = aArr.length;

    for (let c = 0; c < count; c++) {
      const a = aArr[c];
      const b = bArr[c];
      const rest = restArr[c];

      const a3 = a * 3;
      const b3 = b * 3;

      const dx = pos[b3] - pos[a3];
      const dy = pos[b3 + 1] - pos[a3 + 1];
      const dz = pos[b3 + 2] - pos[a3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.0001) continue;

      const error = ((dist - rest) * correctionFactor) / dist;
      const ex = dx * error;
      const ey = dy * error;
      const ez = dz * error;

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
    const targets = this.pinTargets;

    for (let i = 0; i < this.vertexCount; i++) {
      if (!pinned[i]) continue;
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
