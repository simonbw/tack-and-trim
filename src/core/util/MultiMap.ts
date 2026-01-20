const EMPTY_SET: ReadonlySet<never> = new Set();

/** A map of lists. Automatically creates and removes lists as needed. */
export class MultiMap<K, V> {
  private map: Map<K, Set<V>>;

  constructor() {
    this.map = new Map<K, Set<V>>();
  }

  add(key: K, value: V): void {
    if (!this.map.has(key)) {
      this.map.set(key, new Set([value]));
    } else {
      this.map.get(key)!.add(value);
    }
  }

  get(key: K): ReadonlySet<V> {
    return this.map.get(key) ?? EMPTY_SET;
  }

  has(key: K, value: V): boolean {
    return this.map.has(key) && this.map.get(key)!.has(value);
  }

  remove(key: K, value: V): void {
    const set = this.map.get(key);
    if (!set) {
      throw new Error(`<${key}:${value}> not found`);
    }

    const existed = set.delete(value);
    if (!existed) {
      throw new Error(`<${key}:${value}> not found`);
    }
    if (set.size === 0) {
      this.map.delete(key);
    }
  }
}
