/** Function that takes an item and returns true if it is of the desired type */
export type Filter<T, T2 extends T> = (item: T) => item is T2;

/**
 * A set that only contains items matching a predicate function. Automatically filters items as
 * they are added, maintaining a clean subset without manual filtering operations.
 */
export default class FilterSet<T, T2 extends T> implements Iterable<T2> {
  private items: Set<T2> = new Set();

  constructor(private predicate: Filter<T, T2>) {}

  addIfValid(item: T) {
    if (this.predicate(item)) {
      this.items.add(item);
    } else {
      this.remove(item);
    }
  }

  remove(item: T) {
    // No predicate check - item may have changed state since being added
    this.items.delete(item as T2);
  }

  clear() {
    this.items.clear();
  }

  get size() {
    return this.items.size;
  }

  get length() {
    return this.items.size;
  }

  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }
}
