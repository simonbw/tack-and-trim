/**
 * Level loader utility.
 *
 * Provides functions for loading levels from JSON files
 * that can be used by both the editor and the game.
 */

import { RESOURCES } from "../../../resources/resources";
import { TerrainDefinition } from "../../game/world/terrain/TerrainTypes";
import {
  EditorLevelDefinition,
  levelFileToEditorDefinition,
  parseTerrainFile,
  terrainFileToDefinition,
  validateLevelFile,
} from "./TerrainFileFormat";

/**
 * Load the default level definition (for game use).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultLevel(): TerrainDefinition {
  const file = validateLevelFile(RESOURCES.levels.default);
  return terrainFileToDefinition(file);
}

/**
 * Load the default level definition for editor (preserves names).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultEditorLevel(): EditorLevelDefinition {
  const file = validateLevelFile(RESOURCES.levels.default);
  return levelFileToEditorDefinition(file);
}

/**
 * Load level definition from a File object (for editor file input).
 */
export async function loadLevelFromFile(
  file: File,
): Promise<EditorLevelDefinition> {
  const json = await file.text();
  const parsed = parseTerrainFile(json);
  return levelFileToEditorDefinition(parsed);
}
