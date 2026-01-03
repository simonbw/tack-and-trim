import type Equation from "../equations/Equation";
import EventEmitter from "../events/EventEmitter";
import type { Island } from "../world/Island";
import type World from "../world/World";

export interface SolverOptions {
  equationSortFunction?: ((a: Equation, b: Equation) => number) | false;
}

type SolverBody = {
  updateSolveMassProperties(): void;
  resetConstraintVelocity(): void;
  addConstraintVelocity(): void;
};

export interface MinimalWorld {
  bodies: Iterable<SolverBody>;
}

const mockBodies: SolverBody[] = [];
const mockWorld: MinimalWorld = { bodies: mockBodies };

/** Base class for constraint solvers. */
export default abstract class Solver extends EventEmitter {
  /** Current equations in the solver. */
  equations: Equation[] = [];

  /** Function that is used to sort all equations before each solve. */
  equationSortFunction: ((a: Equation, b: Equation) => number) | false;

  constructor(options: SolverOptions = {}) {
    super();

    this.equationSortFunction = options.equationSortFunction || false;
  }

  /**
   * Set the world reference. Override in subclasses that need world access.
   */
  setWorld(_world: World): void {
    // Default implementation does nothing
    // Subclasses like GSSolver override this for optimization
  }

  /** Method to be implemented in each subclass */
  abstract solve(_dt: number, _world: MinimalWorld): void;

  /** Solves all constraints in an island. */
  solveIsland(dt: number, island: Island): void {
    this.removeAllEquations();

    if (island.equations.length) {
      // Add equations to solver
      this.addEquations(island.equations as Equation[]);
      mockBodies.length = 0;
      for (const body of island.bodies) {
        mockBodies.push(body);
      }

      // Solve
      if (mockBodies.length) {
        this.solve(dt, mockWorld);
      }
    }
  }

  /**
   * Sort all equations using the .equationSortFunction. Should be called by
   * subclasses before solving.
   */
  sortEquations(): void {
    if (this.equationSortFunction) {
      this.equations.sort(this.equationSortFunction);
    }
  }

  /** Add an equation to be solved. */
  addEquation(eq: Equation): void {
    if (eq.enabled) {
      this.equations.push(eq);
    }
  }

  /**
   * Add equations. Same as .addEquation, but this time the argument is an
   * array of Equations
   */
  addEquations(eqs: Equation[]): void {
    for (let i = 0, N = eqs.length; i !== N; i++) {
      const eq = eqs[i];
      if (eq.enabled) {
        this.equations.push(eq);
      }
    }
  }

  /** Remove an equation. */
  removeEquation(eq: Equation): void {
    const i = this.equations.indexOf(eq);
    if (i !== -1) {
      this.equations.splice(i, 1);
    }
  }

  /** Remove all currently added equations. */
  removeAllEquations(): void {
    this.equations.length = 0;
  }
}
