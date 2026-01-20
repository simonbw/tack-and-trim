import { mod } from "./MathUtil";

/** Utility functions for doing things based on random numbers. */

// just for shorthand
const r = Math.random;

/** Return a random number between `min` and `max`. */
export function rUniform(min?: number, max?: number): number {
  if (min === undefined) {
    return r();
  }
  if (max === undefined) {
    max = min;
    min = 0;
  }
  return (max - min) * r() + min;
}

/** A random angle in radians */
export function rDirection(): number {
  return rUniform(0, Math.PI * 2);
}

/** One of the four cardinal directions, in radians */
export function rCardinal(): number {
  return choose(0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2);
}

/**
 * Returns a random number from an (approximately) normal distribution
 * centered at `mean` with standard deviation of `deviation`
 */
export function rNormal(mean: number = 0.0, deviation: number = 1.0): number {
  return (deviation * (r() + r() + r() + r() + r() + r() - 3)) / 3 + mean;
}

/** Return true or false, chosen at random. */
export function rBool(chanceOfTrue: number = 0.5): boolean {
  return r() < chanceOfTrue;
}

export function rSign(chanceOfPositive: number = 0.5): -1 | 1 {
  return rBool(chanceOfPositive) ? 1 : -1;
}

/** Return a random integer in range [min, max) */
export function rInteger(min: number, max: number): number {
  return Math.floor(rUniform(min, max));
}

export function rByte(): number {
  return rInteger(0, 256);
}

/** Probabilistically round x to a nearby integer. */
export function rRound(x: number): number {
  const low = Math.floor(x);
  return rBool(x - low) ? low : low + 1;
}

/** Return a random element from a list of options. */
export function choose<T>(...options: T[]): T {
  return options[rInteger(0, options.length)];
}

/** Remove and return a random element from an array. */
export function take<T>(options: T[]): T {
  return options.splice(rInteger(0, options.length), 1)[0];
}

/** Put an array into a random order and return the array. */
export function shuffle<T>(a: T[]): T[] {
  let i, j;
  i = a.length;
  while (--i > 0) {
    j = rInteger(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Put an array into a deterministically random order and return the array. Seed should be an integer */
export function seededShuffle<T>(a: T[], seed: number): T[] {
  let i, j, temp;
  i = a.length;
  while (--i > 0) {
    seed = (seed * 1103515245 + 12345) | 0;
    j = mod(seed, i + 1);
    temp = a[j];
    a[j] = a[i];
    a[i] = temp;
  }
  return a;
}

/**
 * Choose a random element from an array, weighted by the given weight function.
 * Higher weights are more likely to be chosen.
 * @param items The array to choose from
 * @param getWeight Function that returns the weight for each item (must be >= 0)
 * @returns A random item
 */
export function chooseWeighted<T>(
  items: readonly T[],
  getWeight: (item: T) => number,
): T {
  if (items.length === 0) throw new Error("No items to choose from");

  // Calculate total weight
  let totalWeight = 0;
  for (const item of items) {
    const weight = getWeight(item);
    if (weight < 0) {
      throw new Error("Weight must be >= 0");
    }
    totalWeight += weight;
  }

  if (totalWeight <= 0) throw new Error("Total weight must be > 0");

  // Pick random point in weight space
  let pick = r() * totalWeight;
  for (const item of items) {
    pick -= getWeight(item);
    if (pick <= 0) return item;
  }

  // Fallback for floating point edge cases
  return items[items.length - 1];
}

/**
 * Efficient weighted random selection with precomputed cumulative weights.
 * Use when making repeated selections from the same weighted set.
 */
export class WeightedSelector<T> {
  private items: T[] = [];
  private weights: number[] = [];
  private cumulative: number[] = [];
  private itemToIndex: Map<T, number> = new Map();
  private dirty = false;
  private _totalWeight = 0;

  constructor(items?: Iterable<[T, number]>) {
    if (items) {
      for (const [item, weight] of items) {
        this.add(item, weight);
      }
    }
  }

  /** Add an item with its weight. Weight must be >= 0. */
  add(item: T, weight: number): this {
    if (weight < 0) {
      throw new Error("Weight must be >= 0");
    }
    if (this.itemToIndex.has(item)) {
      throw new Error("Item already exists in selector");
    }

    const index = this.items.length;
    this.items.push(item);
    this.weights.push(weight);
    this.itemToIndex.set(item, index);
    this._totalWeight += weight;
    this.dirty = true;

    return this;
  }

  /** Remove an item from the selector. */
  remove(item: T): this {
    const index = this.itemToIndex.get(item);
    if (index === undefined) {
      throw new Error("Item not found in selector");
    }

    this._totalWeight -= this.weights[index];

    // Swap with last element for O(1) removal
    const lastIndex = this.items.length - 1;
    if (index !== lastIndex) {
      const lastItem = this.items[lastIndex];
      this.items[index] = lastItem;
      this.weights[index] = this.weights[lastIndex];
      this.itemToIndex.set(lastItem, index);
    }

    this.items.pop();
    this.weights.pop();
    this.itemToIndex.delete(item);
    this.dirty = true;

    return this;
  }

  /** Remove all items from the selector. */
  clear(): this {
    this.items = [];
    this.weights = [];
    this.cumulative = [];
    this.itemToIndex.clear();
    this._totalWeight = 0;
    this.dirty = false;

    return this;
  }

  /** Pick a random item weighted by the stored weights. Returns undefined if empty. */
  pick(): T | undefined {
    if (this.items.length === 0) return undefined;
    if (this._totalWeight <= 0) return undefined;

    if (this.dirty) {
      this.rebuild();
    }

    const target = r() * this._totalWeight;

    // Binary search for first cumulative > target
    let low = 0;
    let high = this.cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.cumulative[mid] <= target) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return this.items[low];
  }

  /** The number of items in the selector. */
  get size(): number {
    return this.items.length;
  }

  /** The total weight of all items. */
  get totalWeight(): number {
    return this._totalWeight;
  }

  private rebuild(): void {
    this.cumulative.length = this.weights.length;
    let sum = 0;
    for (let i = 0; i < this.weights.length; i++) {
      sum += this.weights[i];
      this.cumulative[i] = sum;
    }
    this.dirty = false;
  }
}
