/**
 * Symbols for solver-internal properties.
 * Import these only in solver code, not in game code.
 *
 * Using symbols hides these properties from autocomplete,
 * making the public API cleaner and more focused.
 */

// Body solver internals
export const SOLVER_VLAMBDA = Symbol("vlambda");
export const SOLVER_WLAMBDA = Symbol("wlambda");
export const SOLVER_INV_MASS = Symbol("invMassSolve");
export const SOLVER_INV_INERTIA = Symbol("invInertiaSolve");
export const SOLVER_RESET_VELOCITY = Symbol("resetConstraintVelocity");
export const SOLVER_ADD_VELOCITY = Symbol("addConstraintVelocity");
export const SOLVER_UPDATE_MASS = Symbol("updateSolveMassProperties");

// Equation solver internals
export const EQ_B = Symbol("B");
export const EQ_INV_C = Symbol("invC");
export const EQ_LAMBDA = Symbol("lambda");
export const EQ_MAX_FORCE_DT = Symbol("maxForceDt");
export const EQ_MIN_FORCE_DT = Symbol("minForceDt");
