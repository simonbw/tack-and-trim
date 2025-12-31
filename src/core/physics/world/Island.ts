import type Body from "../body/Body";
import DynamicBody from "../body/DynamicBody";
import type Equation from "../equations/Equation";

const bodyIds: number[] = [];

/**
 * An island of bodies connected with equations.
 */
export default class Island {
  equations: Equation[] = [];
  bodies: Body[] = [];

  reset(): void {
    this.equations.length = this.bodies.length = 0;
  }

  /**
   * Get all unique bodies in this island.
   */
  getBodies(result: Body[] = []): Body[] {
    const bodies = result;
    const eqs = this.equations;
    bodyIds.length = 0;
    for (let i = 0; i !== eqs.length; i++) {
      const eq = eqs[i];
      if (bodyIds.indexOf(eq.bodyA.id) === -1) {
        bodies.push(eq.bodyA);
        bodyIds.push(eq.bodyA.id);
      }
      if (bodyIds.indexOf(eq.bodyB.id) === -1) {
        bodies.push(eq.bodyB);
        bodyIds.push(eq.bodyB.id);
      }
    }
    return bodies;
  }

  /**
   * Check if the entire island wants to sleep.
   */
  wantsToSleep(): boolean {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b instanceof DynamicBody && !b.wantsToSleep) {
        return false;
      }
    }
    return true;
  }

  /**
   * Make all bodies in the island sleep.
   */
  sleep(): boolean {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      b.sleep();
    }
    return true;
  }
}
