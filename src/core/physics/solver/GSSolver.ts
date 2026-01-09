import DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";
import FrictionEquation from "../equations/FrictionEquation";
import {
  SOLVER_ADD_VELOCITY,
  SOLVER_RESET_VELOCITY,
  SOLVER_UPDATE_MASS,
} from "../internal";
import type { Island } from "../world/Island";
import {
  DEFAULT_SOLVER_CONFIG,
  type Solver,
  type SolverConfig,
  type SolverResult,
} from "./Solver";

/**
 * Gauss-Seidel iterative constraint solver.
 *
 * This is a sequential solver that updates body velocities immediately
 * after computing each constraint impulse. This leads to fast convergence
 * (typically 4-10 iterations) but cannot be parallelized.
 *
 * Also known as "Sequential Impulse" or "Projected Gauss-Seidel" (PGS).
 */
export default class GSSolver implements Solver {
  readonly config: SolverConfig;

  constructor(config: Partial<SolverConfig> = {}) {
    this.config = { ...DEFAULT_SOLVER_CONFIG, ...config };
  }

  solveEquations(
    equations: readonly Equation[],
    dynamicBodies: Iterable<DynamicBody>,
    h: number
  ): SolverResult {
    const {
      iterations,
      tolerance,
      frictionIterations,
      useZeroRHS,
      equationSortFunction,
    } = this.config;

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

    // Update solve mass properties for all dynamic bodies
    for (const body of dynamicBodies) {
      body[SOLVER_UPDATE_MASS]();
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
      Bs[i] = eq.computeB(eq.a, eq.b, h);
      invCs[i] = eq.computeInvC(eq.epsilon);
    }

    // Reset constraint velocities
    for (const body of dynamicBodies) {
      body[SOLVER_RESET_VELOCITY]();
    }

    // Optional friction pre-iteration phase
    if (frictionIterations > 0) {
      for (let iter = 0; iter < frictionIterations; iter++) {
        const deltaTot = this.runIteration(
          equations,
          Bs,
          invCs,
          lambda,
          useZeroRHS,
          h
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
      const deltaTot = this.runIteration(
        equations,
        Bs,
        invCs,
        lambda,
        useZeroRHS,
        h
      );
      usedIterations++;

      if (deltaTot * deltaTot <= tolSquared) {
        break;
      }
    }

    // Apply constraint velocities to bodies
    for (const body of dynamicBodies) {
      body[SOLVER_ADD_VELOCITY]();
    }

    // Update equation multipliers
    updateMultipliers(equations, lambda, 1 / h);

    return { usedIterations };
  }

  solveIsland(island: Island, h: number): SolverResult {
    // Extract dynamic bodies from island
    const dynamicBodies: DynamicBody[] = [];
    for (const body of island.bodies) {
      if (body instanceof DynamicBody) {
        dynamicBodies.push(body);
      }
    }

    return this.solveEquations(island.equations as Equation[], dynamicBodies, h);
  }

  /** Runs one iteration over all equations. Returns total absolute delta. */
  private runIteration(
    equations: readonly Equation[],
    Bs: Float32Array,
    invCs: Float32Array,
    lambda: Float32Array,
    useZeroRHS: boolean,
    h: number
  ): number {
    let deltalambdaTot = 0.0;
    const Neq = equations.length;

    for (let j = 0; j < Neq; j++) {
      const eq = equations[j];
      const deltalambda = this.iterateEquation(
        j,
        eq,
        eq.epsilon,
        Bs,
        invCs,
        lambda,
        useZeroRHS,
        h
      );
      deltalambdaTot += Math.abs(deltalambda);
    }

    return deltalambdaTot;
  }

  /** Iterates a single equation and returns the delta lambda. */
  private iterateEquation(
    j: number,
    eq: Equation,
    eps: number,
    Bs: ArrayLike<number>,
    invCs: ArrayLike<number>,
    lambda: Float32Array,
    useZeroRHS: boolean,
    dt: number
  ): number {
    let B = Bs[j];
    const invC = invCs[j];
    const lambdaj = lambda[j];
    const GWlambda = eq.computeGWlambda();

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
    eq.addToWlambda(deltalambda);

    return deltalambda;
  }
}

// --- Helper Functions ---

/** Sets the .multiplier property of each equation from lambda values. */
function updateMultipliers(
  equations: readonly Equation[],
  lambda: ArrayLike<number>,
  invDt: number
): void {
  for (let i = equations.length - 1; i >= 0; i--) {
    equations[i].multiplier = lambda[i] * invDt;
  }
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
