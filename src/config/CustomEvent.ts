/** Global event types that can be dispatched by the Game and listened to by entities. */
export type CustomEvents = {
  /** Fired when player starts the game from main menu */
  gameStart: {};

  /** Fired when influence field computation is complete and visual entities can be added */
  influenceFieldsReady: {};

  /** Fired when a tutorial step is completed */
  tutorialStepComplete: { stepIndex: number; stepTitle: string };

  /** Fired when the entire tutorial is completed */
  tutorialComplete: {};
};
