/**
 * Misc utility functions
 */

/**
 * The array type to use for internal numeric computations throughout the library.
 * Float32Array is used if it is available, but falls back on Array.
 */
export const ARRAY_TYPE: Float32ArrayConstructor | ArrayConstructor =
  typeof Float32Array !== "undefined" ? Float32Array : Array;

/**
 * Append the values in array b to the array a.
 */
export function appendArray<T>(a: T[], b: T[]): void {
  if (b.length < 150000) {
    a.push.apply(a, b);
  } else {
    for (let i = 0, len = b.length; i !== len; ++i) {
      a.push(b[i]);
    }
  }
}

/**
 * Garbage free Array.splice(). Does not allocate a new array.
 */
export function splice<T>(array: T[], index: number, howmany: number = 1): void {
  const len = array.length - howmany;
  for (let i = index; i < len; i++) {
    array[i] = array[i + howmany];
  }
  array.length = len;
}
