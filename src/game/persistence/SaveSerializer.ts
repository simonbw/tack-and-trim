import type { Game } from "../../core/Game";
import type { Boat } from "../boat/Boat";
import { MissionManager } from "../mission/MissionManager";
import { ProgressionManager } from "../progression/ProgressionManager";
import { CURRENT_SAVE_VERSION, type SaveFile } from "./SaveFile";

/**
 * Collect all saveable game state into a SaveFile object.
 *
 * This is a pure function that reads from living game entities
 * and returns a plain data structure suitable for serialization.
 */
export function collectSaveData(
  game: Game,
  saveName: string,
  levelId: string,
): SaveFile {
  const boat = game.entities.getById("boat") as Boat | undefined;
  if (!boat) {
    throw new Error("Cannot save: no boat entity found");
  }

  const body = boat.hull.body;

  // Read progression state
  const progression = game.entities.tryGetSingleton(ProgressionManager);
  const missionManager = game.entities.tryGetSingleton(MissionManager);
  const missionState = missionManager?.getState();
  const activeMission = missionManager?.getActiveMission();

  return {
    saveName,
    lastSaved: Date.now(),
    version: CURRENT_SAVE_VERSION,
    levelId,

    gameTime: game.elapsedUnpausedTime,

    boat: {
      position: [body.position.x, body.position.y],
      rotation: body.angle,
      velocity: [body.velocity.x, body.velocity.y],
      angularVelocity: body.angularVelocity,
      damage: {
        hull: boat.hullDamage.getHealth(),
        rudder: boat.rudderDamage.getHealth(),
        sail: boat.mainSailDamage.getHealth(),
      },
      bilgeWater: boat.bilge.waterVolume,
      sailor: {
        // In-transit saves persist the destination — the sailor effectively
        // teleports to the target on reload, which is acceptable since
        // transits are short and the alternative (replaying the walk) adds
        // complexity for no gameplay benefit.
        stationId:
          boat.sailor.state.kind === "atStation"
            ? boat.sailor.state.stationId
            : boat.sailor.state.targetStationId,
      },
    },

    progression: {
      money: progression?.getMoney() ?? 0,
      currentBoatId: progression?.getCurrentBoatId() ?? "shaff-s7",
      ownedBoats: progression
        ? progression.getOwnedBoats().map((boatId) => ({
            boatId,
            purchasedUpgrades: progression.getUpgradesForBoat(boatId),
          }))
        : [{ boatId: "shaff-s7", purchasedUpgrades: [] }],
      completedMissions: missionState?.completedMissionIds ?? [],
      currentMission: activeMission
        ? { missionId: activeMission.def.id, state: {} }
        : null,
      discoveredPorts: missionState?.revealedPortIds ?? [],
    },

    world: {
      windSeed: 0,
    },
  };
}
