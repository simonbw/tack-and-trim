/**
 * Misc utility functions
 */

/**
 * The array type to use for internal numeric computations throughout the library.
 * Float32Array is used if it is available, but falls back on Array.
 */
export const ARRAY_TYPE: Float32ArrayConstructor | ArrayConstructor =
  typeof Float32Array !== "undefined" ? Float32Array : Array;
