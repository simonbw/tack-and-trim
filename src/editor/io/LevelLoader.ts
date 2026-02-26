/**
 * Level loader utility.
 *
 * Provides functions for loading level data (terrain + waves) from JSON files
 * that can be used by both the editor and the game.
 */

import { RESOURCES } from "../../../resources/resources";
import {
  EditorLevelDefinition,
  LevelData,
  levelFileToEditorDefinition,
  levelFileToLevelData,
  parseLevelFile,
  validateLevelFile,
} from "./LevelFileFormat";

/**
 * Load the default level data (terrain + waves).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultLevel(): LevelData {
  const file = validateLevelFile(RESOURCES.levels.default);
  return levelFileToLevelData(file);
}

/**
 * Load the default level for editor (preserves names and wave config).
 * Uses the bundled resource from the asset system.
 */
export function loadDefaultEditorLevel(): EditorLevelDefinition {
  const file = validateLevelFile(RESOURCES.levels.default);
  return levelFileToEditorDefinition(file);
}

/**
 * Load level data from a File object (for editor file input).
 */
export async function loadLevelFromFile(
  file: File,
): Promise<EditorLevelDefinition> {
  const json = await file.text();
  const parsed = parseLevelFile(json);
  return levelFileToEditorDefinition(parsed);
}
