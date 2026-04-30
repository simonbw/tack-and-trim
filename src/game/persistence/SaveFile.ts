export const CURRENT_SAVE_VERSION = 4;

export interface SaveFile {
  // Meta
  saveName: string;
  lastSaved: number; // Date.now()
  version: number;
  levelId: string;

  // Time
  gameTime: number;

  // Boat
  boat: {
    position: [number, number];
    rotation: number;
    velocity: [number, number];
    angularVelocity: number;
    damage: {
      hull: number;
      rudder: number;
      sail: number;
    };
    bilgeWater: number;
    /** Station the sailor is at (or in transit to — saves the destination). */
    sailor: {
      stationId: string;
    };
  };

  // Progression
  progression: {
    money: number;
    currentBoatId: string;
    ownedBoats: {
      boatId: string;
      purchasedUpgrades: string[];
    }[];
    completedMissions: string[];
    currentMission: {
      missionId: string;
      state: Record<string, unknown>;
    } | null;
    discoveredPorts: string[];
  };

  // World
  world: {
    windSeed: number;
  };
}

export interface SaveSlotInfo {
  slotId: string;
  saveName: string;
  lastSaved: number;
  levelId: string;
}
