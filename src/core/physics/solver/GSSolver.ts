/**
 * Gauss-Seidel Sequential Impulse (SI) constraint solver.
 *
 * This module implements an iterative Gauss-Seidel method for solving systems
 * of constraint equations in a rigid body physics simulation. The algorithm
 * is equivalent to projected Gauss-Seidel (PGS) — the standard approach used
 * by most real-time physics engines (Box2D, Bullet, etc.).
 *
 * ## Algorithm overview
 *
 * Given N constraint equations, each with a Jacobian row G_i, the solver
 * finds impulse magnitudes lambda_i that satisfy all constraints simultaneously
 * (within tolerance). On each iteration it sweeps through every equation and
 * computes an impulse correction:
 *
 *   delta_lambda_i = invC_i * (B_i - G_i * v_lambda - epsilon_i * lambda_i)
 *
 * where:
 *   - **lambda** is the accumulated constraint impulse (units: N*s = kg*m/s).
 *     Clamped to [minForce*dt, maxForce*dt] to enforce inequality constraints
 *     (e.g. contacts can push but not pull, friction is bounded).
 *   - **B** (the "right-hand side") encodes the constraint violation to be
 *     corrected this timestep. It combines three terms:
 *       B = -a * Gq - b * GW - h * GiMf
 *     where Gq is position error, GW is velocity error, and GiMf is the
 *     external-force contribution. The coefficients a, b come from the
 *     Baumgarte-like stabilization derived from stiffness/relaxation.
 *   - **invC** is the inverse effective mass for the constraint:
 *       invC = 1 / (G * M^-1 * G^T + epsilon)
 *     This is a scalar because each equation is 1-DOF.
 *   - **epsilon** is a compliance/regularization term (units: 1/(kg*m^2/s^2*s^2)
 *     effectively dimensionless after scaling). It softens the constraint,
 *     preventing the effective mass from becoming infinite or ill-conditioned
 *     when bodies have extreme mass ratios. Derived from stiffness and
 *     relaxation: epsilon = 4 / (h^2 * k * (1 + 4d)).
 *
 * After each equation update, the impulse is immediately applied to the
 * participating bodies' velocity accumulators (vlambda, wlambda), so
 * subsequent equations in the same iteration see the updated velocities.
 * This is what makes it "Gauss-Seidel" rather than "Jacobi".
 *
 * ## Per-body state storage
 *
 * The solver stores per-body scratch state (vlambda, wlambda, inverse mass,
 * inverse inertia) in a {@link SolverWorkspace}. Bodies are assigned integer
 * indices at the start of each solve; equations read/write the flat
 * Float64Arrays in the workspace by index. This replaces an earlier design
 * that used `Map<Body, SolverBodyState>` — the index-based layout removes
 * two Map lookups from the inner loop of every equation iteration.
 *
 * ## Friction pre-iterations
 *
 * Friction equations depend on the normal force magnitude from their
 * associated contact equations (Coulomb friction: |f_t| <= mu * |f_n|).
 * The `frictionIterations` parameter runs a preliminary solve pass to
 * estimate contact forces, then updates friction bounds before the main
 * solve. Without this, friction limits on the first iteration would use
 * stale or zero normal force estimates, leading to sliding artifacts.
 *
 * ## Convergence
 *
 * The solver terminates early when the total absolute change in lambda
 * across all equations falls below `tolerance` (squared comparison for
 * efficiency). This means the system has settled and further iterations
 * would produce negligible improvement.
 */
import { profiler } from "../../util/Profiler";
import { DynamicBody } from "../body/DynamicBody";
import type { Equation } from "../equations/Equation";
import { FrictionEquation } from "../equations/FrictionEquation";
import type { Island } from "../world/Island";
import type { SolverWorkspace } from "./SolverWorkspace";

// --- Types ---

export interface SolverConfig {
  /** Maximum number of Gauss-Seidel iterations per solve. Higher values
   *  improve accuracy at the cost of CPU time. Typical range: 5-20. */
  readonly iterations: number;
  /** Early-exit threshold. The solver stops when the sum of |delta_lambda|
   *  across all equations squared is below this value (dimensionless after
   *  normalization). Typical range: 1e-7 to 1e-10. */
  readonly tolerance: number;
  /** Number of preliminary iterations used to estimate normal forces before
   *  the main solve, so friction bounds (mu * f_n) are reasonable from the
   *  start. 0 disables friction pre-iterations. Typical: 0-3. */
  readonly frictionIterations: number;
  /** When true, sets B=0 during iteration (ignores position/velocity error
   *  and external forces). Used for split-impulse / pseudo-velocity schemes
   *  where position correction is handled separately. */
  readonly useZeroRHS: boolean;
  /** Optional comparator to sort equations before solving. Solving order
   *  affects convergence in Gauss-Seidel; sorting contacts by penetration
   *  depth or by body mass ratio can improve stability. False disables sorting. */
  readonly equationSortFunction?:
    | ((a: Equation, b: Equation) => number)
    | false;
}

export interface SolverResult {
  readonly usedIterations: number;
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  iterations: 20,
  tolerance: 1e-3,
  frictionIterations: 0,
  useZeroRHS: false,
  equationSortFunction: (a, b) => a.solverOrder - b.solverOrder,
};

// --- Main Functions ---

/**
 * Solve a set of constraint equations using the iterative Gauss-Seidel method.
 *
 * Updates body velocities and equation multipliers in place. The workspace
 * is owned by the caller and reused across solves; this function calls
 * `workspace.reset()` at the start so callers don't need to.
 */
export function solveEquations(
  equations: readonly Equation[],
  dynamicBodies: Iterable<DynamicBody>,
  h: number,
  config: SolverConfig,
  workspace: SolverWorkspace,
): SolverResult {
  const {
    iterations,
    tolerance,
    frictionIterations,
    useZeroRHS,
    equationSortFunction,
  } = config;

  profiler.start("Solver.setup");

  // Sort if configured
  if (equationSortFunction) {
    equations = equations.toSorted(equationSortFunction);
  }

  // Filter out disabled equations (e.g. bodies with collisionResponse: false)
  equations = equations.filter((eq) => eq.enabled);

  const Neq = equations.length;
  if (Neq === 0) {
    workspace.reset();
    profiler.end("Solver.setup");
    return { usedIterations: 0 };
  }

  const tolSquared = tolerance ** 2;
  let usedIterations = 0;

  // Assign workspace indices. Register dynamic bodies first so their
  // invMass/invInertia slots get filled from the live body data and they
  // show up on the finalize pass. Then let each equation pull in any
  // static/kinematic (or extra pulley) bodies it references.
  workspace.reset();
  for (const body of dynamicBodies) {
    workspace.registerDynamic(body);
  }
  for (let i = 0; i < Neq; i++) {
    equations[i].assignIndices(workspace);
  }

  // Allocate per-equation scratch. Grows geometrically; steady state is
  // zero-alloc.
  workspace.ensureEqCapacity(Neq);
  const lambda = workspace.lambda;
  const Bs = workspace.Bs;
  const invCs = workspace.invCs;
  // Clear only the live region — the tail may hold stale values from a
  // larger previous solve.
  lambda.fill(0, 0, Neq);

  // Prepare equations - compute B and invC values
  for (let i = 0; i < Neq; i++) {
    const eq = equations[i];
    if (eq.timeStep !== h || eq.needsUpdate) {
      eq.timeStep = h;
      eq.update();
    }
    Bs[i] = eq.computeB(eq.a, eq.b, h, workspace);
    invCs[i] = eq.computeInvC(eq.epsilon, workspace);
  }

  profiler.end("Solver.setup");

  profiler.start("Solver.warmStart");
  // Warm start: initialize lambda from previous frame's solution and
  // pre-apply the cached impulses to body velocity deltas. This lets the
  // solver start near the previous solution instead of from zero, which
  // dramatically improves convergence for constraints under steady load.
  for (let i = 0; i < Neq; i++) {
    const eq = equations[i];
    let warm = eq.warmLambda;
    if (warm !== 0) {
      // Clamp to current force bounds (may have changed since last frame)
      const minFDt = eq.minForce * h;
      const maxFDt = eq.maxForce * h;
      if (warm < minFDt) warm = minFDt;
      else if (warm > maxFDt) warm = maxFDt;
      lambda[i] = warm;
      eq.addToWlambda(warm, workspace);
    }
  }
  profiler.end("Solver.warmStart");

  // Optional friction pre-iteration phase
  if (frictionIterations > 0) {
    for (let iter = 0; iter < frictionIterations; iter++) {
      const deltaTot = runIteration(
        equations,
        Bs,
        invCs,
        lambda,
        useZeroRHS,
        h,
        workspace,
      );
      usedIterations++;

      if (deltaTot * deltaTot <= tolSquared) {
        break;
      }
    }

    updateMultipliers(equations, lambda, 1 / h);
    updateFrictionBounds(equations);
  }

  // Main iteration phase
  profiler.start("Solver.iterate");
  for (let iter = 0; iter < iterations; iter++) {
    const deltaTot = runIteration(
      equations,
      Bs,
      invCs,
      lambda,
      useZeroRHS,
      h,
      workspace,
    );
    usedIterations++;

    if (deltaTot * deltaTot <= tolSquared) {
      break;
    }
  }
  profiler.end("Solver.iterate");

  profiler.start("Solver.finalize");
  // Apply constraint velocities to dynamic bodies. The workspace's parallel
  // dynamicBodies/dynamicBodyIndices arrays give us each dynamic body along
  // with its slot in the flat vlambda/wlambda arrays.
  const dynBodies = workspace.dynamicBodies;
  const dynIdx = workspace.dynamicBodyIndices;
  const vl = workspace.vlambda;
  const wl = workspace.wlambda;
  const dynCount = dynBodies.length;
  for (let i = 0; i < dynCount; i++) {
    const body = dynBodies[i];
    const base = dynIdx[i] * 3;

    // Linear velocity (x, y always; z only for 6DOF)
    body.velocity.x += vl[base];
    body.velocity.y += vl[base + 1];

    // Angular velocity (all 3 axes via the 3-vector)
    const av = body.angularVelocity3;
    av[0] += wl[base];
    av[1] += wl[base + 1];
    av[2] += wl[base + 2];

    // Z velocity (only meaningful for 6DOF bodies; vlambda[base+2] is 0 for
    // 3DOF because invMassSolveZ is 0, so this is a no-op for 3DOF)
    if (body.is6DOF) {
      body.zVelocity += vl[base + 2];
    }
  }

  // Cache lambda for warm starting next frame, then update multipliers
  for (let i = 0; i < Neq; i++) {
    equations[i].warmLambda = lambda[i];
  }
  updateMultipliers(equations, lambda, 1 / h);
  profiler.end("Solver.finalize");

  return { usedIterations };
}

/**
 * Solve all equations in an island.
 *
 * Extracts dynamic bodies from the island and delegates to solveEquations.
 * The caller is responsible for passing a workspace; when solving multiple
 * islands in one step, the same workspace can be reused (it will be reset
 * at the start of each `solveEquations` call).
 */
export function solveIsland(
  island: Island,
  h: number,
  config: SolverConfig,
  workspace: SolverWorkspace,
): SolverResult {
  // Extract dynamic bodies from island
  const dynamicBodies: DynamicBody[] = [];
  for (const body of island.bodies) {
    if (body instanceof DynamicBody) {
      dynamicBodies.push(body);
    }
  }

  return solveEquations(
    island.equations as Equation[],
    dynamicBodies,
    h,
    config,
    workspace,
  );
}

// --- Helper Functions ---

/** Sets the .multiplier property of each equation from lambda values. */
function updateMultipliers(
  equations: readonly Equation[],
  lambda: ArrayLike<number>,
  invDt: number,
): void {
  for (let i = equations.length - 1; i >= 0; i--) {
    equations[i].multiplier = lambda[i] * invDt;
  }
}

/** Runs one iteration over all equations. Returns total absolute delta. */
function runIteration(
  equations: readonly Equation[],
  Bs: Float32Array,
  invCs: Float32Array,
  lambda: Float32Array,
  useZeroRHS: boolean,
  h: number,
  workspace: SolverWorkspace,
): number {
  let deltalambdaTot = 0.0;
  const Neq = equations.length;

  for (let j = 0; j < Neq; j++) {
    const eq = equations[j];
    const deltalambda = iterateEquation(
      j,
      eq,
      eq.epsilon,
      Bs,
      invCs,
      lambda,
      useZeroRHS,
      h,
      workspace,
    );
    deltalambdaTot += Math.abs(deltalambda);
  }

  return deltalambdaTot;
}

/**
 * Iterates a single equation and returns the change in impulse (delta lambda).
 *
 * Core PGS update rule:
 *   delta_lambda = invC * (B - GWlambda - epsilon * lambda)
 *
 * - GWlambda is the current constraint velocity from accumulated impulses
 * - epsilon * lambda is the regularization/compliance feedback term
 * - The result is clamped so that the total lambda stays within
 *   [minForce*dt, maxForce*dt], enforcing inequality constraints
 */
function iterateEquation(
  j: number,
  eq: Equation,
  eps: number,
  Bs: ArrayLike<number>,
  invCs: ArrayLike<number>,
  lambda: Float32Array,
  useZeroRHS: boolean,
  dt: number,
  workspace: SolverWorkspace,
): number {
  let B = Bs[j];
  const invC = invCs[j];
  const lambdaj = lambda[j];
  const GWlambda = eq.computeGWlambda(workspace);

  const maxForce = eq.maxForce;
  const minForce = eq.minForce;

  if (useZeroRHS) {
    B = 0;
  }

  let deltalambda = invC * (B - GWlambda - eps * lambdaj);
  if (!isFinite(deltalambda)) deltalambda = 0;

  // Clamp if we are not within the min/max interval
  const lambdaj_plus_deltalambda = lambdaj + deltalambda;
  if (lambdaj_plus_deltalambda < minForce * dt) {
    deltalambda = minForce * dt - lambdaj;
  } else if (lambdaj_plus_deltalambda > maxForce * dt) {
    deltalambda = maxForce * dt - lambdaj;
  }
  lambda[j] += deltalambda;
  eq.addToWlambda(deltalambda, workspace);

  return deltalambda;
}

/** Updates friction equation bounds based on contact equation multipliers. */
function updateFrictionBounds(equations: readonly Equation[]): void {
  for (const eq of equations) {
    if (eq instanceof FrictionEquation) {
      let f = 0.0;
      for (let k = 0; k < eq.contactEquations.length; k++) {
        f += eq.contactEquations[k].multiplier;
      }
      f *= eq.frictionCoefficient / eq.contactEquations.length;
      eq.maxForce = f;
      eq.minForce = -f;
    }
  }
}
