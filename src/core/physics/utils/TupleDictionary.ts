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
    if (id1 === id2) {
      return -1;
    }

    // valid for values < 2^16
    return id1 > id2
      ? (id1 << 16) | (id2 & 0xffff)
      : (id2 << 16) | (id1 & 0xffff);
  }

  getByKey(key: number): T | undefined {
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

    for (let i = keys.length - 1; i >= 0; i--) {
      delete data[keys[i]];
    }

    keys.length = 0;
  }

  copy(dict: TupleDictionary<T>): void {
    this.reset();
    appendArray(this.keys, dict.keys);
    for (let i = dict.keys.length - 1; i >= 0; i--) {
      const key = dict.keys[i];
      this.data[key] = dict.data[key];
    }
  }
}
