/** Global event types that can be dispatched by the Game and listened to by entities. */
export type CustomEvents = {
  /** Fired when player starts the game from main menu */
  gameStart: {};

  /** Fired when a tutorial step is completed */
  tutorialStepComplete: { stepIndex: number; stepTitle: string };

  /** Fired when the entire tutorial is completed */
  tutorialComplete: {};

  /** Fired when a WaveShadow finishes computing shadow geometry */
  shadowsComputed: { waveIndex: number; polygonCount: number };

  /** Fired when terrain contours are added, removed, or modified */
  terrainContoursChanged: { contourCount: number };
};
