/**
 * Options for Pool constructor
 */
export interface PoolOptions {
  size?: number;
}

/**
 * Object pooling utility.
 */
export default class Pool<T> {
  objects: T[] = [];

  constructor(options: PoolOptions = {}) {
    if (options.size !== undefined) {
      this.resize(options.size);
    }
  }

  /**
   * Resize the pool
   * @param size Target size
   * @returns Self, for chaining
   */
  resize(size: number): this {
    const objects = this.objects;

    while (objects.length > size) {
      objects.pop();
    }

    while (objects.length < size) {
      objects.push(this.create());
    }

    return this;
  }

  /**
   * Get an object from the pool or create a new instance.
   * @returns An object from the pool or a new instance
   */
  get(): T {
    const objects = this.objects;
    return objects.length ? objects.pop()! : this.create();
  }

  /**
   * Clean up and put the object back into the pool for later use.
   * @param object The object to release
   * @returns Self for chaining
   */
  release(object: T): this {
    this.destroy(object);
    this.objects.push(object);
    return this;
  }

  /**
   * Create a new object. Override this in subclasses.
   */
  create(): T {
    throw new Error("Pool.create() must be overridden in subclass");
  }

  /**
   * Clean up an object before returning it to the pool. Override this in subclasses.
   */
  destroy(_object: T): void {
    // Override in subclass
  }
}
