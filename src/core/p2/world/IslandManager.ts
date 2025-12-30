import Island from "./Island";
import IslandNode from "./IslandNode";
import IslandNodePool from "../utils/IslandNodePool";
import IslandPool from "../utils/IslandPool";
import Body from "../objects/Body";
import type Equation from "../equations/Equation";
import type World from "./World";

/**
 * Splits the system of bodies and equations into independent islands
 */
export default class IslandManager {
  nodePool: IslandNodePool;
  islandPool: IslandPool;
  equations: Equation[] = [];
  islands: Island[] = [];
  nodes: IslandNode[] = [];
  queue: IslandNode[] = [];

  constructor() {
    this.nodePool = new IslandNodePool({ size: 16 });
    this.islandPool = new IslandPool({ size: 8 });
  }

  /**
   * Get an unvisited node from a list of nodes.
   */
  static getUnvisitedNode(nodes: IslandNode[]): IslandNode | false {
    const Nnodes = nodes.length;
    for (let i = 0; i !== Nnodes; i++) {
      const node = nodes[i];
      if (!node.visited && node.body?.type === Body.DYNAMIC) {
        return node;
      }
    }
    return false;
  }

  /**
   * Visit a node.
   */
  visit(node: IslandNode, bds: Body[], eqs: Equation[]): void {
    bds.push(node.body!);
    const Neqs = node.equations.length;
    for (let i = 0; i !== Neqs; i++) {
      const eq = node.equations[i];
      if (eqs.indexOf(eq) === -1) {
        eqs.push(eq);
      }
    }
  }

  /**
   * Runs the search algorithm, starting at a root node.
   */
  bfs(root: IslandNode, bds: Body[], eqs: Equation[]): void {
    const queue = this.queue;
    queue.length = 0;

    queue.push(root);
    root.visited = true;
    this.visit(root, bds, eqs);

    while (queue.length) {
      const node = queue.pop()!;

      let child: IslandNode | false;
      while ((child = IslandManager.getUnvisitedNode(node.neighbors))) {
        child.visited = true;
        this.visit(child, bds, eqs);

        if (child.body?.type === Body.DYNAMIC) {
          queue.push(child);
        }
      }
    }
  }

  /**
   * Split the world into independent islands.
   */
  split(world: World): Island[] {
    const bodies = world.bodies;
    const nodes = this.nodes;
    const equations = this.equations;

    // Move old nodes to the node pool
    while (nodes.length) {
      this.nodePool.release(nodes.pop()!);
    }

    // Create needed nodes, reuse if possible
    for (let i = 0; i !== bodies.length; i++) {
      const node = this.nodePool.get();
      node.body = bodies[i];
      nodes.push(node);
    }

    // Add connectivity data. Each equation connects 2 bodies.
    for (let k = 0; k !== equations.length; k++) {
      const eq = equations[k];
      const i = bodies.indexOf(eq.bodyA);
      const j = bodies.indexOf(eq.bodyB);
      const ni = nodes[i];
      const nj = nodes[j];
      ni.neighbors.push(nj);
      nj.neighbors.push(ni);
      ni.equations.push(eq);
      nj.equations.push(eq);
    }

    // Move old islands to the island pool
    const islands = this.islands;
    for (let i = 0; i < islands.length; i++) {
      this.islandPool.release(islands[i]);
    }
    islands.length = 0;

    // Get islands
    let child: IslandNode | false;
    while ((child = IslandManager.getUnvisitedNode(nodes))) {
      const island = this.islandPool.get();
      this.bfs(child, island.bodies, island.equations);
      islands.push(island);
    }

    return islands;
  }
}
