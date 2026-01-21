import { V, V2d } from "../../../core/Vector";

/**
 * Flow state at a single sail segment.
 * Propagated from luff to leech to model stall and turbulence effects.
 */
export interface FlowState {
  /** Apparent wind velocity at this segment */
  velocity: V2d;
  /** Magnitude of velocity (cached for convenience) */
  speed: number;
  /** Is flow attached to the sail surface? */
  attached: boolean;
  /** Turbulence intensity (0-1), inherited from upstream with decay */
  turbulence: number;
  /** Distance along sail since stall started (0 = attached) */
  stallDistance: number;
}

/** Default flow state with zero velocity and attached flow */
export const DEFAULT_FLOW_STATE: FlowState = {
  velocity: V(0, 0),
  speed: 0,
  attached: true,
  turbulence: 0,
  stallDistance: 0,
};

/** Create a fresh flow state (to avoid mutating the default) */
export function createFlowState(): FlowState {
  return {
    velocity: V(0, 0),
    speed: 0,
    attached: true,
    turbulence: 0,
    stallDistance: 0,
  };
}
