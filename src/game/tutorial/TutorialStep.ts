import type { Boat } from "../boat/Boat";
import type { WorldManager } from "../world/WorldManager";
import type { V2d } from "../../core/Vector";

/** Context passed to step completion checks and callbacks */
export interface TutorialContext {
  /** The player's boat */
  boat: Boat;
  /** World manager for getting wind information */
  worldManager: WorldManager;
  /** Boat position when the current step started */
  stepStartPosition: V2d;
  /** Boat heading (radians) when the current step started */
  stepStartHeading: number;
  /** Mainsheet position (0-1) when the current step started */
  stepStartMainsheetPosition: number;
  /** Which tack (port/starboard) the boat was on when the step started */
  stepStartTack: "port" | "starboard";
  /** Where the boat was when the entire tutorial began */
  tutorialStartPosition: V2d;
}

/** Definition of a single tutorial step */
export interface TutorialStep {
  /** Step title shown prominently */
  title: string;
  /** Explanation text */
  description: string;
  /** Current objective shown highlighted */
  objective: string;
  /** Optional keyboard hint (e.g., "F", "A/D") */
  keyHint?: string;
  /** Called each tick - return true when objective is complete */
  checkComplete: (ctx: TutorialContext) => boolean;
  /** Optional setup when step starts */
  onStart?: (ctx: TutorialContext) => void;
}
