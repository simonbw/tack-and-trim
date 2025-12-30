import { appendArray } from "./Utils";

/**
 * Stores data keyed by integer pairs.
 */
export default class TupleDictionary<T = any> {
  data: Record<number, T> = {};
  keys: number[] = [];

  /**
   * Generate a key given two integers
   */
  getKey(id1: number, id2: number): number {
    id1 = id1 | 0;
    id2 = id2 | 0;

    if ((id1 | 0) === (id2 | 0)) {
      return -1;
    }

    // valid for values < 2^16
    return (
      ((id1 | 0) > (id2 | 0)
        ? (id1 << 16) | (id2 & 0xffff)
        : (id2 << 16) | (id1 & 0xffff)) | 0
    );
  }

  getByKey(key: number): T | undefined {
    key = key | 0;
    return this.data[key];
  }

  get(i: number, j: number): T | undefined {
    return this.data[this.getKey(i, j)];
  }

  set(i: number, j: number, value: T): number {
    if (!value) {
      throw new Error("No data!");
    }

    const key = this.getKey(i, j);

    // Check if key already exists
    if (!this.data[key]) {
      this.keys.push(key);
    }

    this.data[key] = value;

    return key;
  }

  reset(): void {
    const data = this.data;
    const keys = this.keys;

    let l = keys.length;
    while (l--) {
      delete data[keys[l]];
    }

    keys.length = 0;
  }

  copy(dict: TupleDictionary<T>): void {
    this.reset();
    appendArray(this.keys, dict.keys);
    let l = dict.keys.length;
    while (l--) {
      const key = dict.keys[l];
      this.data[key] = dict.data[key];
    }
  }
}
