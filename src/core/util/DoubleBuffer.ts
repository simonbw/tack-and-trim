/**
 * Simple double buffer for alternating read/write access.
 * Useful for async operations where one buffer is read while another is written.
 */
export class DoubleBuffer<T> {
  private a: T;
  private b: T;
  private readPtr: T;

  constructor(a: T, b: T) {
    this.a = a;
    this.b = b;
    this.readPtr = a;
  }

  /** Get the buffer currently available for reading */
  getRead(): T {
    return this.readPtr;
  }

  /** Get the buffer currently available for writing */
  getWrite(): T {
    return this.readPtr === this.a ? this.b : this.a;
  }

  /** Swap read and write buffers */
  swap(): void {
    this.readPtr = this.getWrite();
  }
}
