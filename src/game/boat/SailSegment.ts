import { V2d } from "../../core/Vector";
import { FlowState } from "./FlowState";

/**
 * A single segment of a sail with geometry and flow state.
 * Segments are ordered from luff (leading edge) to leech (trailing edge).
 */
export interface SailSegment {
  /** Segment midpoint in world coordinates */
  position: V2d;
  /** Unit vector along segment (luff to leech direction) */
  tangent: V2d;
  /** Unit vector perpendicular to segment (leeward side is positive) */
  normal: V2d;
  /** Segment length in ft */
  length: number;
  /** Local curvature / camber (0 = flat) */
  camber: number;

  /** Flow state (propagated from luff) */
  flow: FlowState;

  /** High pressure side (windward, positive) */
  pressureWindward: number;
  /** Low pressure side (leeward, negative = suction) */
  pressureLeeward: number;
}
