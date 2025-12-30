import Pool, { PoolOptions } from "./Pool";
import OverlapKeeperRecord from "./OverlapKeeperRecord";

export default class OverlapKeeperRecordPool extends Pool<OverlapKeeperRecord> {
  constructor(options?: PoolOptions) {
    super(options);
  }

  create(): OverlapKeeperRecord {
    return new OverlapKeeperRecord();
  }

  destroy(_object: OverlapKeeperRecord): OverlapKeeperRecordPool {
    return this;
  }
}
