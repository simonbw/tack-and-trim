import { UnifiedBody } from "./UnifiedBody";

/** Sleep state for dynamic bodies. */
export enum SleepState {
  /** Body is active and simulated. */
  AWAKE = 0,
  /** Body is nearly idle and may sleep soon. */
  SLEEPY = 1,
  /** Body is sleeping and not simulated until woken. */
  SLEEPING = 2,
}

/**
 * During the unified-body refactor the abstract `Body` base class was
 * replaced by {@link UnifiedBody} — a single concrete class with shape +
 * motion tags. This file re-exports UnifiedBody as `Body` so existing
 * consumers (BodyManager, World, narrowphase, springs, etc.) keep
 * compiling and running unchanged.
 */
export { UnifiedBody as Body };
