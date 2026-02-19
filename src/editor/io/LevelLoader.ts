/**
 * Level loader utility.
 *
 * Provides functions for loading level data (terrain + waves) from JSON files
 * that can be used by both the editor and the game.
 */

import { RESOURCES } from "../../../resources/resources";
import { TerrainDefinition } from "../../game/world/terrain/LandMass";
import { WaveConfig } from "../../game/world/water/WaveSource";
import {
  LevelData,
  levelFileToLevelData,
  levelFileToTerrainDefinition,
  levelFileToWaveConfig,
  parseLevelFile,
  validateLevelFile,
} from "./LevelFileFormat";

/**
 * Load the default level data (terrain + waves).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultLevel(): LevelData {
  const file = validateLevelFile(RESOURCES.levels.sanJuanIslands);
  return levelFileToLevelData(file);
}

/**
 * Load only the terrain definition from the default level (for backward compatibility).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultTerrain(): TerrainDefinition {
  const file = validateLevelFile(RESOURCES.levels.sanJuanIslands);
  return levelFileToTerrainDefinition(file);
}

/**
 * Load only the wave config from the default level.
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultWaveConfig(): WaveConfig {
  const file = validateLevelFile(RESOURCES.levels.sanJuanIslands);
  return levelFileToWaveConfig(file);
}

/**
 * Load level data from a File object (for editor file input).
 */
export async function loadLevelFromFile(file: File): Promise<LevelData> {
  const json = await file.text();
  const parsed = parseLevelFile(json);
  return levelFileToLevelData(parsed);
}
