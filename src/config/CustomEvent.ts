/** Global event types that can be dispatched by the Game and listened to by entities. */
export type CustomEvents = {
  /** Fired when player starts the game from main menu */
  gameStart: {};

  /** Fired when a tutorial step is completed */
  tutorialStepComplete: { stepIndex: number; stepTitle: string };

  /** Fired when the entire tutorial is completed */
  tutorialComplete: {};

  // Mission events

  /** Fired when a mission becomes unlocked */
  missionUnlocked: { missionId: string };

  /** Fired when a mission is started */
  missionStarted: { missionId: string };

  /** Fired when a mission objective is completed */
  missionObjectiveComplete: { missionId: string; objectiveIndex: number };

  /** Fired when a mission is successfully completed */
  missionComplete: { missionId: string; time: number };

  /** Fired when a mission is failed */
  missionFailed: { missionId: string; reason: string };

  /** Fired when a mission is quit by the player */
  missionQuit: { missionId: string };
};
