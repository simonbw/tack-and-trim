/**
 * Terrain loader utility.
 *
 * Provides functions for loading terrain from JSON files
 * that can be used by both the editor and the game.
 */

import { RESOURCES } from "../../../resources/resources";
import { TerrainDefinition } from "../../game/world-data/terrain/LandMass";
import {
  EditorTerrainDefinition,
  parseTerrainFile,
  terrainFileToDefinition,
  terrainFileToEditorDefinition,
  validateTerrainFile,
} from "./TerrainFileFormat";

/**
 * Load the default terrain definition (for game use).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultTerrain(): TerrainDefinition {
  const file = validateTerrainFile(RESOURCES.levels.default);
  return terrainFileToDefinition(file);
}

/**
 * Load the default terrain definition for editor (preserves names).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultEditorTerrain(): EditorTerrainDefinition {
  const file = validateTerrainFile(RESOURCES.levels.default);
  return terrainFileToEditorDefinition(file);
}

/**
 * Load terrain definition from a File object (for editor file input).
 */
export async function loadTerrainFromFile(
  file: File,
): Promise<EditorTerrainDefinition> {
  const json = await file.text();
  const parsed = parseTerrainFile(json);
  return terrainFileToEditorDefinition(parsed);
}
