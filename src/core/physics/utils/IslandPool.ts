import Pool, { PoolOptions } from "./Pool";
import Island from "../world/Island";

export default class IslandPool extends Pool<Island> {
  constructor(options?: PoolOptions) {
    super(options);
  }

  create(): Island {
    return new Island();
  }

  destroy(island: Island): IslandPool {
    island.reset();
    return this;
  }
}
