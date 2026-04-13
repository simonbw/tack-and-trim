/**
 * Solver scratch state for a single `solveEquations` call.
 *
 * Replaces the previous `Map<Body, SolverBodyState>` approach with an
 * index-based Structure-of-Arrays layout. Bodies receive a stable integer
 * index for the duration of one solve; all per-body solver state lives in
 * flat Float64Arrays owned by this workspace.
 *
 * ## Why
 *
 * The old Map-based design allocated a Map, per-body state objects, and
 * per-body Float64Arrays on every solve (8x per physics step with substeps),
 * and the hot iteration loop did 2-4 Map lookups per equation per iteration.
 * Profiling showed `Solver.iterate` at ~5ms per step, dominated by the Map
 * traffic rather than the actual constraint math.
 *
 * This workspace is constructed once, owned by `World`, and reused across
 * every solve. The backing arrays grow geometrically on demand and then
 * stabilize; after the first few frames, a solve performs zero allocations
 * outside the index-assignment Map (which is cleared between calls).
 *
 * ## Separation of concerns
 *
 * `Body` and `DynamicBody` remain unaware of the solver. Equations accept
 * a `SolverWorkspace` as an opaque handle — they know the workspace exposes
 * `vlambda`, `wlambda`, `invMassSolve`, etc. by index, but not how that
 * storage is organized. A different solver could supply its own workspace.
 */

import { Body } from "../body/Body";
import { DynamicBody } from "../body/DynamicBody";

export class SolverWorkspace {
  /** Number of bodies currently registered in this solve. */
  bodyCount: number = 0;

  /** Backing capacity for per-body arrays. Grows geometrically. */
  private bodyCapacity: number = 0;

  /** Linear constraint-velocity accumulator, 3 floats per body: [vx, vy, vz]. */
  vlambda: Float64Array = new Float64Array(0);

  /** Angular constraint-velocity accumulator, 3 floats per body: [wx, wy, wz]. */
  wlambda: Float64Array = new Float64Array(0);

  /** Linear inverse mass for x/y, per body. Zero for sleeping/static/kinematic bodies. */
  invMassSolve: Float64Array = new Float64Array(0);

  /** Linear inverse mass for z, per body. Zero for non-6DOF bodies and sleeping ones. */
  invMassSolveZ: Float64Array = new Float64Array(0);

  /**
   * World-frame 3x3 inverse inertia tensor reference per body. Each entry is
   * either `body.invWorldInertia` (for awake dynamic) or `Body.ZERO_9` (for
   * sleeping/static/kinematic). Kept as references — no copy.
   */
  invInertia: Float64Array[] = [];

  /**
   * Dynamic bodies that should receive their accumulated vlambda/wlambda on
   * finalize. Populated in the order they are registered. Parallel to
   * `dynamicBodyIndices`.
   */
  dynamicBodies: DynamicBody[] = [];

  /** Workspace index for each entry in `dynamicBodies`. */
  dynamicBodyIndices: number[] = [];

  /** Per-equation impulse accumulator. Length = current equation count. */
  lambda: Float32Array = new Float32Array(0);

  /** Per-equation right-hand side. Length = current equation count. */
  Bs: Float32Array = new Float32Array(0);

  /** Per-equation inverse effective mass. Length = current equation count. */
  invCs: Float32Array = new Float32Array(0);

  /** Backing capacity for per-equation arrays. Grows geometrically. */
  private eqCapacity: number = 0;

  /**
   * Body -> index map. Only touched during the setup phase of a solve (never
   * by the hot iteration loop). Cleared in `reset()`.
   */
  private bodyToIndex: Map<Body, number> = new Map();

  /** Clear all per-solve state. Call at the start of each `solveEquations`. */
  reset(): void {
    // Zero the live portion of vlambda/wlambda so accumulation starts clean.
    // Clearing only what was used avoids touching unused capacity.
    if (this.bodyCount > 0) {
      const count3 = this.bodyCount * 3;
      this.vlambda.fill(0, 0, count3);
      this.wlambda.fill(0, 0, count3);
    }
    this.bodyCount = 0;
    this.bodyToIndex.clear();
    this.dynamicBodies.length = 0;
    this.dynamicBodyIndices.length = 0;
  }

  /** Ensure per-body arrays can hold at least `needed` bodies. */
  ensureBodyCapacity(needed: number): void {
    if (needed <= this.bodyCapacity) return;
    const newCap = Math.max(needed, this.bodyCapacity * 2, 16);
    const newVl = new Float64Array(newCap * 3);
    const newWl = new Float64Array(newCap * 3);
    const newInvM = new Float64Array(newCap);
    const newInvMz = new Float64Array(newCap);
    // Copy live region (reset() will zero it next solve, but be safe mid-solve
    // if we ever grow during a single call).
    newVl.set(this.vlambda);
    newWl.set(this.wlambda);
    newInvM.set(this.invMassSolve);
    newInvMz.set(this.invMassSolveZ);
    this.vlambda = newVl;
    this.wlambda = newWl;
    this.invMassSolve = newInvM;
    this.invMassSolveZ = newInvMz;
    // invInertia is a plain array of references; just extend it.
    while (this.invInertia.length < newCap) {
      this.invInertia.push(Body.ZERO_9);
    }
    this.bodyCapacity = newCap;
  }

  /** Ensure per-equation arrays can hold at least `needed` equations. */
  ensureEqCapacity(needed: number): void {
    if (needed <= this.eqCapacity) return;
    const newCap = Math.max(needed, this.eqCapacity * 2, 64);
    this.lambda = new Float32Array(newCap);
    this.Bs = new Float32Array(newCap);
    this.invCs = new Float32Array(newCap);
    this.eqCapacity = newCap;
  }

  /**
   * Look up or assign an index for this body. Defaults to treating the body
   * as non-sleeping, which is correct for static/kinematic bodies pulled in
   * via equations (their invMass is naturally 0).
   *
   * Dynamic bodies should be registered via `registerDynamic()` instead so
   * the finalize pass knows about them.
   */
  indexOf(body: Body): number {
    const existing = this.bodyToIndex.get(body);
    if (existing !== undefined) return existing;
    return this.assign(body, false);
  }

  /**
   * Register a dynamic body. Sets invMass/invInertia from the body (or to
   * zero if sleeping) and records it for the finalize pass.
   */
  registerDynamic(body: DynamicBody): number {
    const existing = this.bodyToIndex.get(body);
    if (existing !== undefined) return existing;
    const idx = this.assign(body, body.isSleeping());
    this.dynamicBodies.push(body);
    this.dynamicBodyIndices.push(idx);
    return idx;
  }

  /** @internal */
  private assign(body: Body, isSleeping: boolean): number {
    const idx = this.bodyCount++;
    this.ensureBodyCapacity(this.bodyCount);
    // Freshly-grown vlambda/wlambda slots are already zero (new Float64Array).
    if (isSleeping) {
      this.invMassSolve[idx] = 0;
      this.invMassSolveZ[idx] = 0;
      this.invInertia[idx] = Body.ZERO_9;
    } else {
      this.invMassSolve[idx] = body.invMass;
      this.invMassSolveZ[idx] = body.invMassZ;
      this.invInertia[idx] = body.invWorldInertia;
    }
    this.bodyToIndex.set(body, idx);
    return idx;
  }
}
