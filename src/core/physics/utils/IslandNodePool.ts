import Pool, { PoolOptions } from "./Pool";
import IslandNode from "../world/IslandNode";

export default class IslandNodePool extends Pool<IslandNode> {
  constructor(options?: PoolOptions) {
    super(options);
  }

  create(): IslandNode {
    return new IslandNode();
  }

  destroy(node: IslandNode): IslandNodePool {
    node.reset();
    return this;
  }
}
