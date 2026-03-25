import type { Game } from "../../core/Game";
import type { Boat } from "../boat/Boat";
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
      anchorDeployed: boat.anchor.isDeployed(),
    },

    progression: {
      money: 0,
      currentBoatId: "starter-dinghy",
      ownedBoats: [{ boatId: "starter-dinghy", purchasedUpgrades: [] }],
      completedMissions: [],
      currentMission: null,
      discoveredPorts: [],
    },

    world: {
      windSeed: 0,
    },
  };
}
