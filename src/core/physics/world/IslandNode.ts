import type Body from "../body/Body";
import type Equation from "../equations/Equation";

/**
 * Holds a body and keeps track of some additional properties needed for graph traversal.
 */
export default class IslandNode {
  body: Body | null;
  neighbors: IslandNode[] = [];
  equations: Equation[] = [];
  visited: boolean = false;

  constructor(body?: Body) {
    this.body = body || null;
  }

  reset(): void {
    this.equations.length = 0;
    this.neighbors.length = 0;
    this.visited = false;
    this.body = null;
  }
}
