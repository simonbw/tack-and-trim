export const CURRENT_SAVE_VERSION = 3;

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
    /** Sailor state: station id if at a station, or hull-local position if walking. */
    sailor: {
      stationId: string | null;
      position: [number, number];
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
