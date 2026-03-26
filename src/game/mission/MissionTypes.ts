/**
 * Mission type definitions for the progression system.
 */

import type { MissionDef } from "../../editor/io/LevelFileFormat";

export type { MissionDef } from "../../editor/io/LevelFileFormat";

/**
 * A mission that the player has accepted and is currently working on.
 */
export interface ActiveMission {
  /** The mission definition */
  def: MissionDef;
  /** Game time (in seconds) when the mission was accepted */
  startTime: number;
}
