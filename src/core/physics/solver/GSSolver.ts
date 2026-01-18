import type Body from "../body/Body";
import DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";
import FrictionEquation from "../equations/FrictionEquation";
import { V, V2d } from "../../Vector";
import type { Island } from "../world/Island";

// --- Types ---

/** Ephemeral solver state for a body during constraint resolution. */
export interface SolverBodyState {
  /** Linear constraint velocity accumulator */
  vlambda: V2d;
  /** Angular constraint velocity accumulator */
  wlambda: number;
  /** 0 if sleeping, else body.invMass */
  invMassSolve: number;
  /** 0 if sleeping, else body.invInertia */
  invInertiaSolve: number;
}

/** Creates initial solver state for a body. */
function createSolverState(body: Body, isSleeping: boolean): SolverBodyState {
  return {
    vlambda: V(),
    wlambda: 0,
    invMassSolve: isSleeping ? 0 : body.invMass,
    invInertiaSolve: isSleeping ? 0 : body.invInertia,
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
    body.velocity.iadd(state.vlambda);
    body.angularVelocity += state.wlambda;
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
