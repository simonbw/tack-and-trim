import type { LevelName } from "../../resources/resources";

/** Global event types that can be dispatched by the Game and listened to by entities. */
export type CustomEvents = {
  /** Fired when player selects a level from the main menu */
  levelSelected: { levelName: LevelName };

  /** Fired when player starts the game from main menu */
  gameStart: {};

  /** Fired when a tutorial step is completed */
  tutorialStepComplete: { stepIndex: number; stepTitle: string };

  /** Fired when the entire tutorial is completed */
  tutorialComplete: {};

  /** Fired when the boat begins sinking (water at 100%) */
  boatSinking: {};

  /** Fired when the boat has fully sunk (after sinking animation) */
  boatSunk: {};

  /** Fired from game over screen to restart the current level */
  restartLevel: {};

  /** Fired from game over screen to return to main menu */
  returnToMenu: {};
};
