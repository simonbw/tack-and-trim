import type { LevelName } from "../../resources/resources";

/** Global event types that can be dispatched by the Game and listened to by entities. */
export type CustomEvents = {
  /** Fired when player selects a level from the main menu */
  levelSelected: { levelName: LevelName };

  /** Fired when player selects a boat from the boat selection screen */
  boatSelected: { boatId: string; levelName: LevelName };

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

  /** Fired when the hull takes damage from grounding or collision */
  hullDamaged: { damage: number; health: number; source: "grounding" };

  /** Fired when the rudder takes damage from grounding or collision */
  rudderDamaged: { damage: number; health: number; source: "grounding" };

  /** Fired when a sail takes damage from overpowering or jibe */
  sailDamaged: {
    damage: number;
    health: number;
    sail: "main" | "jib";
    source: "overpower" | "jibe";
  };

  /** Fired when the boat is moored to a port */
  boatMoored: { portId: string; portName: string };

  /** Fired when the boat casts off from a port */
  boatUnmoored: { portId: string };

  /** Fired when the player accepts a new mission */
  missionAccepted: { missionId: string };

  /** Fired when a mission is completed */
  missionCompleted: {
    missionId: string;
    rewards: { money?: number; revealPorts?: string[] };
  };

  /** Fired to buy a boat */
  buyBoat: { boatId: string };

  /** Fired to buy an upgrade for a boat */
  buyUpgrade: { boatId: string; upgradeId: string };

  /** Fired to repair the current boat */
  repairBoat: {};

  /** Fired to switch to a different owned boat */
  switchBoat: { boatId: string };

  /** Fired when the shipyard UI opens */
  openShipyard: {};

  /** Fired when the shipyard UI closes */
  closeShipyard: {};
};
