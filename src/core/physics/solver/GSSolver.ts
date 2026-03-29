import { Body } from "../body/Body";
import { DynamicBody } from "../body/DynamicBody";
import type { Equation } from "../equations/Equation";
import { FrictionEquation } from "../equations/FrictionEquation";
import type { Island } from "../world/Island";

// --- Types ---

/** Ephemeral solver state for a body during constraint resolution. */
export interface SolverBodyState {
  /** Linear constraint velocity accumulator [vx, vy, vz] */
  vlambda: Float64Array;
  /** Angular constraint velocity accumulator [wx, wy, wz] in world frame */
  wlambda: Float64Array;
  /** 0 if sleeping, else body.invMass (for x, y axes) */
  invMassSolve: number;
  /** 0 if sleeping or non-6DOF, else body.invMassZ */
  invMassSolveZ: number;
  /** World-frame 3x3 inverse inertia tensor (row-major). Reference to body's array. */
  invInertiaSolve: Float64Array;
}

/** Creates initial solver state for a body. */
function createSolverState(body: Body, isSleeping: boolean): SolverBodyState {
  return {
    vlambda: new Float64Array(3),
    wlambda: new Float64Array(3),
    invMassSolve: isSleeping ? 0 : body.invMass,
    invMassSolveZ: isSleeping ? 0 : body.invMassZ,
    invInertiaSolve: isSleeping ? Body.ZERO_9 : body.invWorldInertia,
  };
}

export interface SolverConfig {
  readonly iterations: number;
  readonly tolerance: number;
  readonly frictionIterations: number;
  readonly useZeroRHS: boolean;
  readonly equationSortFunction?:
    | ((a: Equation, b: Equation) => number)
    | false;
}

export interface SolverResult {
  readonly usedIterations: number;
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  iterations: 10,
  tolerance: 1e-7,
  frictionIterations: 0,
  useZeroRHS: false,
  equationSortFunction: false,
};

// --- Main Functions ---

/**
 * Solve a set of constraint equations using the iterative Gauss-Seidel method.
 *
 * This is a pure function that takes equations and bodies, solves the
 * constraints, and updates body velocities and equation multipliers in place.
 */
export function solveEquations(
  equations: readonly Equation[],
  dynamicBodies: Iterable<DynamicBody>,
  h: number,
  config: SolverConfig,
): SolverResult {
  const {
    iterations,
    tolerance,
    frictionIterations,
    useZeroRHS,
    equationSortFunction,
  } = config;

  // Sort if configured
  if (equationSortFunction) {
    equations = equations.toSorted(equationSortFunction);
  }

  // Filter out disabled equations (e.g. bodies with collisionResponse: false)
  equations = equations.filter((eq) => eq.enabled);

  const Neq = equations.length;
  if (Neq === 0) {
    return { usedIterations: 0 };
  }

  const tolSquared = (tolerance * Neq) ** 2;
  let usedIterations = 0;

  // Create solver state map for all bodies in equations
  const bodyState = new Map<Body, SolverBodyState>();

  // Initialize state for dynamic bodies
  for (const body of dynamicBodies) {
    bodyState.set(body, createSolverState(body, body.isSleeping()));
  }

  // Ensure all bodies in equations have state (for static/kinematic bodies)
  for (const eq of equations) {
    if (!bodyState.has(eq.bodyA)) {
      bodyState.set(eq.bodyA, createSolverState(eq.bodyA, false));
    }
    if (!bodyState.has(eq.bodyB)) {
      bodyState.set(eq.bodyB, createSolverState(eq.bodyB, false));
    }
  }

  // Allocate fresh arrays
  const lambda = new Float32Array(Neq);
  const Bs = new Float32Array(Neq);
  const invCs = new Float32Array(Neq);

  // Prepare equations - compute B and invC values
  for (let i = 0; i < Neq; i++) {
    const eq = equations[i];
    if (eq.timeStep !== h || eq.needsUpdate) {
      eq.timeStep = h;
      eq.update();
    }
    Bs[i] = eq.computeB(eq.a, eq.b, h, bodyState);
    invCs[i] = eq.computeInvC(eq.epsilon, bodyState);
  }

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
        bodyState,
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
  for (let iter = 0; iter < iterations; iter++) {
    const deltaTot = runIteration(
      equations,
      Bs,
      invCs,
      lambda,
      useZeroRHS,
      h,
      bodyState,
    );
    usedIterations++;

    if (deltaTot * deltaTot <= tolSquared) {
      break;
    }
  }

  // Apply constraint velocities to dynamic bodies
  for (const body of dynamicBodies) {
    const state = bodyState.get(body)!;
    const vl = state.vlambda;
    const wl = state.wlambda;

    // Linear velocity (x, y always; z only for 6DOF)
    body.velocity.x += vl[0];
    body.velocity.y += vl[1];

    // Angular velocity (all 3 axes via the 3-vector)
    const av = body.angularVelocity3;
    av[0] += wl[0];
    av[1] += wl[1];
    av[2] += wl[2];

    // Z velocity (only meaningful for 6DOF bodies; vlambda[2] is 0 for 3DOF
    // because invMassSolveZ is 0, so this is a no-op for 3DOF)
    if (body.is6DOF) {
      body.zVelocity += vl[2];
    }
  }

  // Update equation multipliers
  updateMultipliers(equations, lambda, 1 / h);

  return { usedIterations };
}

/**
 * Solve all equations in an island.
 *
 * Extracts dynamic bodies from the island and delegates to solveEquations.
 */
export function solveIsland(
  island: Island,
  h: number,
  config: SolverConfig,
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
  bodyState: Map<Body, SolverBodyState>,
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
      bodyState,
    );
    deltalambdaTot += Math.abs(deltalambda);
  }

  return deltalambdaTot;
}

/** Iterates a single equation and returns the delta lambda. */
function iterateEquation(
  j: number,
  eq: Equation,
  eps: number,
  Bs: ArrayLike<number>,
  invCs: ArrayLike<number>,
  lambda: Float32Array,
  useZeroRHS: boolean,
  dt: number,
  bodyState: Map<Body, SolverBodyState>,
): number {
  let B = Bs[j];
  const invC = invCs[j];
  const lambdaj = lambda[j];
  const GWlambda = eq.computeGWlambda(bodyState);

  const maxForce = eq.maxForce;
  const minForce = eq.minForce;

  if (useZeroRHS) {
    B = 0;
  }

  let deltalambda = invC * (B - GWlambda - eps * lambdaj);

  // Clamp if we are not within the min/max interval
  const lambdaj_plus_deltalambda = lambdaj + deltalambda;
  if (lambdaj_plus_deltalambda < minForce * dt) {
    deltalambda = minForce * dt - lambdaj;
  } else if (lambdaj_plus_deltalambda > maxForce * dt) {
    deltalambda = maxForce * dt - lambdaj;
  }
  lambda[j] += deltalambda;
  eq.addToWlambda(deltalambda, bodyState);

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
