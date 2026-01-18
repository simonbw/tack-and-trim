import type { ReadonlyV2d } from "../../core/Vector";
import type { Boat } from "../boat/Boat";
import type { WaterInfo } from "../water/WaterInfo";
import type { WindInfo } from "../wind/WindInfo";

/**
 * Context passed to objective checkers during mission execution.
 * Bundles all game state relevant to checking mission progress.
 */
export interface MissionContext {
  /** The player's boat */
  boat: Boat;

  /** Wind information */
  windInfo: WindInfo;

  /** Water information */
  waterInfo: WaterInfo;

  /** Boat position when the mission started */
  missionStartPosition: ReadonlyV2d;

  /** Timestamp when the mission started (performance.now()) */
  missionStartTime: number;

  /** Current timestamp */
  currentTime: number;

  /** Time elapsed since mission start in seconds */
  elapsedTime: number;

  /** Boat position on the previous tick (for crossing detection) */
  previousBoatPosition: ReadonlyV2d;
}
