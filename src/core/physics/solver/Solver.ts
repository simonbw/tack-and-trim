import type DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";
import type { Island } from "../world/Island";

/**
 * Configuration for constraint solvers.
 */
export interface SolverConfig {
  /** Maximum number of iterations. */
  readonly iterations: number;
  /** Convergence tolerance - solver stops early if change falls below this. */
  readonly tolerance: number;
  /** Additional iterations for friction equations (Gauss-Seidel only). */
  readonly frictionIterations: number;
  /** If true, use zero right-hand side (for position correction). */
  readonly useZeroRHS: boolean;
  /** Optional function to sort equations before solving. */
  readonly equationSortFunction?:
    | ((a: Equation, b: Equation) => number)
    | false;
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  iterations: 10,
  tolerance: 1e-7,
  frictionIterations: 0,
  useZeroRHS: false,
  equationSortFunction: false,
};

/**
 * Result returned by solver after solving constraints.
 */
export interface SolverResult {
  /** Number of iterations actually used (may be less than max if converged early). */
  readonly usedIterations: number;
}

/**
 * Interface for constraint solvers.
 *
 * Solvers take a set of constraint equations and bodies, then compute
 * impulses that satisfy the constraints. Different implementations may
 * use different algorithms (Gauss-Seidel, Jacobi, etc.) with different
 * performance/parallelism tradeoffs.
 */
export interface Solver {
  /** Solver configuration (iterations, tolerance, etc.) */
  readonly config: SolverConfig;

  /**
   * Solve a set of constraint equations.
   *
   * Updates body velocities and equation multipliers in place.
   *
   * @param equations - Constraint equations to solve
   * @param dynamicBodies - Dynamic bodies involved in the equations
   * @param h - Time step
   * @returns Result containing iteration count
   */
  solveEquations(
    equations: readonly Equation[],
    dynamicBodies: Iterable<DynamicBody>,
    h: number
  ): SolverResult;

  /**
   * Solve all equations in an island.
   *
   * Convenience method that extracts dynamic bodies from the island
   * and delegates to solveEquations.
   *
   * @param island - Island containing bodies and equations
   * @param h - Time step
   * @returns Result containing iteration count
   */
  solveIsland(island: Island, h: number): SolverResult;

  /**
   * Release any resources held by the solver (GPU buffers, etc.)
   * Called when the solver is no longer needed.
   */
  dispose?(): void;
}
