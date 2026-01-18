/**
 * Symbols for solver-internal properties on equations.
 * Import these only in solver code, not in game code.
 *
 * Using symbols hides these properties from autocomplete,
 * making the public API cleaner and more focused.
 */

// Equation solver internals
export const EQ_B = Symbol("B");
export const EQ_INV_C = Symbol("invC");
export const EQ_LAMBDA = Symbol("lambda");
export const EQ_MAX_FORCE_DT = Symbol("maxForceDt");
export const EQ_MIN_FORCE_DT = Symbol("minForceDt");
