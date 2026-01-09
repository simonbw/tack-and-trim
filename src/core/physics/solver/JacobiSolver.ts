import DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";
import FrictionEquation from "../equations/FrictionEquation";
import {
  SOLVER_ADD_VELOCITY,
  SOLVER_INV_INERTIA,
  SOLVER_INV_MASS,
  SOLVER_RESET_VELOCITY,
  SOLVER_UPDATE_MASS,
  SOLVER_VLAMBDA,
  SOLVER_WLAMBDA,
} from "../internal";
import type { Island } from "../world/Island";
import {
  DEFAULT_SOLVER_CONFIG,
  type Solver,
  type SolverConfig,
  type SolverResult,
} from "./Solver";

/**
 * Default configuration for Jacobi solver.
 * Jacobi typically needs more iterations than Gauss-Seidel to converge.
 */
const DEFAULT_JACOBI_CONFIG: SolverConfig = {
  ...DEFAULT_SOLVER_CONFIG,
  iterations: 20, // Jacobi needs ~2x iterations of Gauss-Seidel
};

/**
 * Jacobi iterative constraint solver.
 *
 * Unlike Gauss-Seidel, the Jacobi method reads body velocities from the
 * previous iteration while writing updates to a separate buffer. This makes
 * all equation updates independent and parallelizable.
 *
 * Trade-offs vs Gauss-Seidel:
 * - PRO: Fully parallelizable (GPU/SIMD friendly)
 * - CON: Slower convergence (needs ~2x iterations)
 * - CON: Can oscillate without damping (uses SOR relaxation)
 *
 * This implementation runs on the CPU but demonstrates the algorithm.
 * A GPU-accelerated version would use the same approach with textures.
 */
export default class JacobiSolver implements Solver {
  readonly config: SolverConfig;

  /**
   * Successive Over-Relaxation factor.
   * Values < 1 add damping to prevent oscillation.
   * Typical values: 0.5-0.9
   */
  private readonly omega: number;

  constructor(config: Partial<SolverConfig> = {}, omega: number = 0.7) {
    this.config = { ...DEFAULT_JACOBI_CONFIG, ...config };
    this.omega = omega;
  }

  solveEquations(
    equations: readonly Equation[],
    dynamicBodies: Iterable<DynamicBody>,
    h: number
  ): SolverResult {
    const { iterations, tolerance, frictionIterations, useZeroRHS } =
      this.config;

    // Filter out disabled equations
    equations = equations.filter((eq) => eq.enabled);

    const Neq = equations.length;
    if (Neq === 0) {
      return { usedIterations: 0 };
    }

    // Convert to array for indexed access
    const bodiesArray = Array.from(dynamicBodies);
    const Nbodies = bodiesArray.length;

    if (Nbodies === 0) {
      return { usedIterations: 0 };
    }

    const tolSquared = (tolerance * Neq) ** 2;
    let usedIterations = 0;

    // Update solve mass properties for all dynamic bodies
    for (const body of bodiesArray) {
      body[SOLVER_UPDATE_MASS]();
    }

    // Pre-compute equation constants
    const lambda = new Float32Array(Neq);
    const Bs = new Float32Array(Neq);
    const invCs = new Float32Array(Neq);

    for (let i = 0; i < Neq; i++) {
      const eq = equations[i];
      if (eq.timeStep !== h || eq.needsUpdate) {
        eq.timeStep = h;
        eq.update();
      }
      Bs[i] = eq.computeB(eq.a, eq.b, h);
      invCs[i] = eq.computeInvC(eq.epsilon);
    }

    // Reset constraint velocities on bodies
    for (const body of bodiesArray) {
      body[SOLVER_RESET_VELOCITY]();
    }

    // Allocate buffers for Jacobi iteration
    // We need to read from "old" velocities while writing to "new"
    // Body velocities: [vx, vy, omega] per body
    const vlambdaOld = new Float32Array(Nbodies * 3);
    const vlambdaNew = new Float32Array(Nbodies * 3);

    // Build body index map for fast lookup
    const bodyIndexMap = new Map<DynamicBody, number>();
    for (let i = 0; i < Nbodies; i++) {
      bodyIndexMap.set(bodiesArray[i], i);
    }

    // Optional friction pre-iteration phase
    if (frictionIterations > 0) {
      for (let iter = 0; iter < frictionIterations; iter++) {
        const deltaTot = this.runJacobiIteration(
          equations,
          bodiesArray,
          bodyIndexMap,
          Bs,
          invCs,
          lambda,
          vlambdaOld,
          vlambdaNew,
          useZeroRHS,
          h
        );
        usedIterations++;

        if (deltaTot * deltaTot <= tolSquared) {
          break;
        }
      }

      // Copy vlambdaNew back to bodies for friction bound update
      this.copyVelocityToBodies(bodiesArray, vlambdaNew);
      updateMultipliers(equations, lambda, 1 / h);
      updateFrictionBounds(equations);

      // Reset for main phase
      vlambdaOld.fill(0);
      vlambdaNew.fill(0);
    }

    // Main iteration phase
    for (let iter = 0; iter < iterations; iter++) {
      const deltaTot = this.runJacobiIteration(
        equations,
        bodiesArray,
        bodyIndexMap,
        Bs,
        invCs,
        lambda,
        vlambdaOld,
        vlambdaNew,
        useZeroRHS,
        h
      );
      usedIterations++;

      if (deltaTot * deltaTot <= tolSquared) {
        break;
      }
    }

    // Copy final velocities to bodies
    this.copyVelocityToBodies(bodiesArray, vlambdaNew);

    // Apply constraint velocities to actual body velocities
    for (const body of bodiesArray) {
      body[SOLVER_ADD_VELOCITY]();
    }

    // Update equation multipliers
    updateMultipliers(equations, lambda, 1 / h);

    return { usedIterations };
  }

  solveIsland(island: Island, h: number): SolverResult {
    const dynamicBodies: DynamicBody[] = [];
    for (const body of island.bodies) {
      if (body instanceof DynamicBody) {
        dynamicBodies.push(body);
      }
    }

    return this.solveEquations(
      island.equations as Equation[],
      dynamicBodies,
      h
    );
  }

  /**
   * Run one Jacobi iteration over all equations.
   *
   * Key difference from Gauss-Seidel: We read from vlambdaOld and
   * accumulate into vlambdaNew. All equations see the same "old" state,
   * making them independent and parallelizable.
   */
  private runJacobiIteration(
    equations: readonly Equation[],
    bodies: DynamicBody[],
    bodyIndexMap: Map<DynamicBody, number>,
    Bs: Float32Array,
    invCs: Float32Array,
    lambda: Float32Array,
    vlambdaOld: Float32Array,
    vlambdaNew: Float32Array,
    useZeroRHS: boolean,
    dt: number
  ): number {
    const Neq = equations.length;
    const omega = this.omega;

    // Clear new velocity buffer (we accumulate fresh each iteration)
    vlambdaNew.fill(0);

    let deltalambdaTot = 0;

    // Process all equations in parallel (conceptually)
    // Each equation reads from vlambdaOld, writes deltas to vlambdaNew
    for (let j = 0; j < Neq; j++) {
      const eq = equations[j];
      const G = eq.G;

      // Get body indices
      const bodyA = eq.bodyA as DynamicBody;
      const bodyB = eq.bodyB as DynamicBody;
      const idxA = bodyIndexMap.get(bodyA);
      const idxB = bodyIndexMap.get(bodyB);

      // Compute GWlambda using OLD velocities
      // GWlambda = G · vlambda_old
      let GWlambda = 0;

      if (idxA !== undefined) {
        const baseA = idxA * 3;
        GWlambda +=
          G[0] * vlambdaOld[baseA] +
          G[1] * vlambdaOld[baseA + 1] +
          G[2] * vlambdaOld[baseA + 2];
      }

      if (idxB !== undefined) {
        const baseB = idxB * 3;
        GWlambda +=
          G[3] * vlambdaOld[baseB] +
          G[4] * vlambdaOld[baseB + 1] +
          G[5] * vlambdaOld[baseB + 2];
      }

      // Compute delta lambda
      let B = useZeroRHS ? 0 : Bs[j];
      const invC = invCs[j];
      const lambdaj = lambda[j];
      const eps = eq.epsilon;

      let deltalambda = invC * (B - GWlambda - eps * lambdaj);

      // Apply SOR relaxation to prevent oscillation
      deltalambda *= omega;

      // Clamp to force bounds
      const maxForce = eq.maxForce;
      const minForce = eq.minForce;
      const lambdaj_plus_deltalambda = lambdaj + deltalambda;

      if (lambdaj_plus_deltalambda < minForce * dt) {
        deltalambda = minForce * dt - lambdaj;
      } else if (lambdaj_plus_deltalambda > maxForce * dt) {
        deltalambda = maxForce * dt - lambdaj;
      }

      lambda[j] += deltalambda;
      deltalambdaTot += Math.abs(deltalambda);

      // Accumulate velocity changes to NEW buffer
      // v_lambda_new += inv(M) * delta_lambda * G
      if (idxA !== undefined) {
        const invMassA = bodyA[SOLVER_INV_MASS];
        const invInertiaA = bodyA[SOLVER_INV_INERTIA];
        const baseA = idxA * 3;

        vlambdaNew[baseA] += invMassA * G[0] * deltalambda;
        vlambdaNew[baseA + 1] += invMassA * G[1] * deltalambda;
        vlambdaNew[baseA + 2] += invInertiaA * G[2] * deltalambda;
      }

      if (idxB !== undefined) {
        const invMassB = bodyB[SOLVER_INV_MASS];
        const invInertiaB = bodyB[SOLVER_INV_INERTIA];
        const baseB = idxB * 3;

        vlambdaNew[baseB] += invMassB * G[3] * deltalambda;
        vlambdaNew[baseB + 1] += invMassB * G[4] * deltalambda;
        vlambdaNew[baseB + 2] += invInertiaB * G[5] * deltalambda;
      }
    }

    // Swap buffers: new becomes old for next iteration
    vlambdaOld.set(vlambdaNew);

    return deltalambdaTot;
  }

  /**
   * Copy velocity buffer back to body solver properties.
   */
  private copyVelocityToBodies(
    bodies: DynamicBody[],
    vlambda: Float32Array
  ): void {
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i];
      const base = i * 3;
      body[SOLVER_VLAMBDA][0] = vlambda[base];
      body[SOLVER_VLAMBDA][1] = vlambda[base + 1];
      body[SOLVER_WLAMBDA] = vlambda[base + 2];
    }
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
