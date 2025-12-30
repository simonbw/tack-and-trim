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

/**
 * Extend an object with the properties of another
 */
export function extend<T extends object, U extends object>(a: T, b: U): T & U {
  for (const key in b) {
    (a as Record<string, unknown>)[key] = b[key];
  }
  return a as T & U;
}

/**
 * Extend an options object with default values.
 */
export function defaults<T extends object>(
  options: Partial<T> | undefined,
  defaultValues: T
): T {
  const result = options || ({} as Partial<T>);
  for (const key in defaultValues) {
    if (!(key in result)) {
      result[key] = defaultValues[key];
    }
  }
  return result as T;
}

const Utils = {
  ARRAY_TYPE,
  appendArray,
  splice,
  extend,
  defaults,
};

export default Utils;
