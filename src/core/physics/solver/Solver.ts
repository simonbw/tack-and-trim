import EventEmitter from "../events/EventEmitter";
import type Equation from "../equations/Equation";
import type Island from "../world/Island";
import type World from "../world/World";

export interface SolverOptions {
  equationSortFunction?: ((a: Equation, b: Equation) => number) | false;
}

export interface MinimalWorld {
  bodies: { updateSolveMassProperties(): void; resetConstraintVelocity(): void; addConstraintVelocity(): void }[];
}

const mockWorld: MinimalWorld = { bodies: [] };

/**
 * Base class for constraint solvers.
 */
export default class Solver extends EventEmitter {
  static readonly GS = 1;
  static readonly ISLAND = 2;

  type: number;

  /**
   * Current equations in the solver.
   */
  equations: Equation[] = [];

  /**
   * Function that is used to sort all equations before each solve.
   */
  equationSortFunction: ((a: Equation, b: Equation) => number) | false;

  constructor(options: SolverOptions = {}, type?: number) {
    super();

    this.type = type ?? 0;
    this.equationSortFunction = options.equationSortFunction || false;
  }

  /**
   * Set the world reference. Override in subclasses that need world access.
   */
  setWorld(_world: World): void {
    // Default implementation does nothing
    // Subclasses like GSSolver override this for optimization
  }

  /**
   * Method to be implemented in each subclass
   */
  solve(_dt: number, _world: MinimalWorld): void {
    throw new Error("Solver.solve should be implemented by subclasses!");
  }

  /**
   * Solves all constraints in an island.
   */
  solveIsland(dt: number, island: Island): void {
    this.removeAllEquations();

    if (island.equations.length) {
      // Add equations to solver
      this.addEquations(island.equations);
      mockWorld.bodies.length = 0;
      island.getBodies(mockWorld.bodies as any);

      // Solve
      if (mockWorld.bodies.length) {
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

  /**
   * Add an equation to be solved.
   */
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

  /**
   * Remove an equation.
   */
  removeEquation(eq: Equation): void {
    const i = this.equations.indexOf(eq);
    if (i !== -1) {
      this.equations.splice(i, 1);
    }
  }

  /**
   * Remove all currently added equations.
   */
  removeAllEquations(): void {
    this.equations.length = 0;
  }
}
