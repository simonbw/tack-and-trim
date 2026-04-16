import type { Game } from "../../core/Game";
import type { Boat } from "../boat/Boat";
import type { SaveFile } from "./SaveFile";

/**
 * Apply saved state back to living game entities.
 *
 * This must be called AFTER the level has been loaded and all entities exist.
 * It restores non-positional state (damage, bilge). Position and
 * rotation are handled by constructing the Boat at the saved position.
 */
export function applySaveData(game: Game, save: SaveFile): void {
  const boat = game.entities.getById("boat") as Boat | undefined;
  if (!boat) {
    throw new Error("Cannot load save: no boat entity found");
  }

  const boatState = save.boat;

  // Restore damage health values
  boat.hullDamage.setHealth(boatState.damage.hull);
  boat.rudderDamage.setHealth(boatState.damage.rudder);
  boat.mainSailDamage.setHealth(boatState.damage.sail);

  // Restore bilge water volume
  boat.bilge.waterVolume = boatState.bilgeWater;

  // Restore sailor state
  boat.sailor.restoreState(
    boatState.sailor.stationId,
    boatState.sailor.position,
  );
}
