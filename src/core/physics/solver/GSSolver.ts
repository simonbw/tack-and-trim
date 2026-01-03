import type Equation from "../equations/Equation";
import FrictionEquation from "../equations/FrictionEquation";
import type World from "../world/World";
import Solver, { MinimalWorld, SolverOptions } from "./Solver";

const ARRAY_TYPE = Float32Array;
type ArrayType = Float32Array;

export interface GSSolverOptions extends SolverOptions {
  iterations?: number;
  tolerance?: number;
  frictionIterations?: number;
}

function setArrayZero(array: ArrayType): void {
  for (let i = array.length - 1; i >= 0; i--) {
    array[i] = +0.0;
  }
}

/** Iterative Gauss-Seidel constraint equation solver. */
export default class GSSolver extends Solver {
  /**
   * The max number of iterations to do when solving. More gives better
   * results, but is more expensive.
   */
  iterations: number;

  /**
   * The error tolerance, per constraint. If the total error is below this
   * limit, the solver will stop iterating. Set to zero for as good solution
   * as possible, but to something larger than zero to make computations faster.
   */
  tolerance: number;

  arrayStep: number = 30;
  lambda: ArrayType;
  Bs: ArrayType;
  invCs: ArrayType;

  /** Set to true to set all right hand side terms to zero when solving. */
  useZeroRHS: boolean = false;

  /**
   * Number of solver iterations that are used to approximate normal forces
   * used for friction (F_friction = mu * F_normal).
   */
  frictionIterations: number;

  /** The number of iterations that were made during the last solve. */
  usedIterations: number = 0;

  /** Reference to the world for optimized body iteration. */
  world?: World;

  /** Set the world reference for optimized dynamic body iteration. */
  setWorld(world: World): void {
    this.world = world;
  }

  constructor(options: GSSolverOptions = {}) {
    super(options);

    this.iterations = options.iterations || 10;
    this.tolerance = options.tolerance || 1e-7;
    this.lambda = new ARRAY_TYPE(this.arrayStep);
    this.Bs = new ARRAY_TYPE(this.arrayStep);
    this.invCs = new ARRAY_TYPE(this.arrayStep);
    this.frictionIterations =
      options.frictionIterations !== undefined ? options.frictionIterations : 0;
  }

  /** Solve the system of equations */
  solve(h: number, world: MinimalWorld): void {
    this.sortEquations();

    let iter = 0;
    const maxIter = this.iterations;
    const maxFrictionIter = this.frictionIterations;
    const equations = this.equations;
    const Neq = equations.length;
    const tolSquared = Math.pow(this.tolerance * Neq, 2);
    const useZeroRHS = this.useZeroRHS;
    let lambda = this.lambda;

    // Use dynamicBodies Set when available for better performance
    const dynamicBodies = this.world?.bodies.dynamic;

    this.usedIterations = 0;

    if (Neq) {
      // Update solve mass properties
      if (dynamicBodies) {
        for (const b of dynamicBodies) {
          b.updateSolveMassProperties();
        }
      } else {
        for (const b of world.bodies) {
          b.updateSolveMassProperties();
        }
      }
    }

    // Things that does not change during iteration can be computed once
    if (lambda.length < Neq) {
      lambda = this.lambda = new ARRAY_TYPE(Neq + this.arrayStep);
      this.Bs = new ARRAY_TYPE(Neq + this.arrayStep);
      this.invCs = new ARRAY_TYPE(Neq + this.arrayStep);
    }
    setArrayZero(lambda);
    const invCs = this.invCs;
    const Bs = this.Bs;
    lambda = this.lambda;

    for (let i = 0; i !== equations.length; i++) {
      const c = equations[i];
      if (c.timeStep !== h || c.needsUpdate) {
        c.timeStep = h;
        c.update();
      }
      Bs[i] = c.computeB(c.a, c.b, h);
      invCs[i] = c.computeInvC(c.epsilon);
    }

    let deltalambdaTot: number;

    if (Neq !== 0) {
      // Reset constraint velocities
      if (dynamicBodies) {
        for (const b of dynamicBodies) {
          b.resetConstraintVelocity();
        }
      } else {
        for (const b of world.bodies) {
          b.resetConstraintVelocity();
        }
      }

      if (maxFrictionIter) {
        // Iterate over contact equations to get normal forces
        for (iter = 0; iter !== maxFrictionIter; iter++) {
          // Accumulate the total error for each iteration.
          deltalambdaTot = 0.0;

          for (let j = 0; j !== Neq; j++) {
            const c = equations[j];
            const deltalambda = GSSolver.iterateEquation(
              j,
              c,
              c.epsilon,
              Bs,
              invCs,
              lambda,
              useZeroRHS,
              h,
              iter
            );
            deltalambdaTot += Math.abs(deltalambda);
          }

          this.usedIterations++;

          // If the total error is small enough - stop iterate
          if (deltalambdaTot * deltalambdaTot <= tolSquared) {
            break;
          }
        }

        GSSolver.updateMultipliers(equations, lambda, 1 / h);

        // Set computed friction force
        for (let j = 0; j !== Neq; j++) {
          const eq = equations[j];
          if (eq instanceof FrictionEquation) {
            let f = 0.0;
            for (let k = 0; k !== eq.contactEquations.length; k++) {
              f += eq.contactEquations[k].multiplier;
            }
            f *= eq.frictionCoefficient / eq.contactEquations.length;
            eq.maxForce = f;
            eq.minForce = -f;
          }
        }
      }

      // Iterate over all equations
      for (iter = 0; iter !== maxIter; iter++) {
        // Accumulate the total error for each iteration.
        deltalambdaTot = 0.0;

        for (let j = 0; j !== Neq; j++) {
          const c = equations[j];
          const deltalambda = GSSolver.iterateEquation(
            j,
            c,
            c.epsilon,
            Bs,
            invCs,
            lambda,
            useZeroRHS,
            h,
            iter
          );
          deltalambdaTot += Math.abs(deltalambda);
        }

        this.usedIterations++;

        // If the total error is small enough - stop iterate
        if (deltalambdaTot * deltalambdaTot <= tolSquared) {
          break;
        }
      }

      // Add result to velocity
      if (dynamicBodies) {
        for (const b of dynamicBodies) {
          b.addConstraintVelocity();
        }
      } else {
        for (const b of world.bodies) {
          b.addConstraintVelocity();
        }
      }

      GSSolver.updateMultipliers(equations, lambda, 1 / h);
    }
  }

  // Sets the .multiplier property of each equation
  static updateMultipliers(
    equations: Equation[],
    lambda: ArrayLike<number>,
    invDt: number
  ): void {
    for (let i = equations.length - 1; i >= 0; i--) {
      equations[i].multiplier = lambda[i] * invDt;
    }
  }

  static iterateEquation(
    j: number,
    eq: Equation,
    eps: number,
    Bs: ArrayLike<number>,
    invCs: ArrayLike<number>,
    lambda: Float32Array | number[],
    useZeroRHS: boolean,
    dt: number,
    iter: number
  ): number {
    // Compute iteration
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
