/**
 * Level loader utility.
 *
 * Provides functions for loading level data (terrain + waves + wavemesh) from
 * bundled resources. Used by both the editor and the game.
 */

import type { WavefrontMeshData } from "../../pipeline/mesh-building/MeshBuildTypes";
import type { WindMeshFileData } from "../../pipeline/mesh-building/WindmeshFile";
import { loadWavemeshFromUrl } from "../../game/wave-physics/WavemeshLoader";
import { loadWindmeshFromUrl } from "../../game/wind/WindmeshLoader";
import { RESOURCES, LevelName } from "../../../resources/resources";
import {
  EditorLevelDefinition,
  LevelData,
  levelFileToEditorDefinition,
  levelFileToLevelData,
  parseLevelFile,
  validateLevelFile,
} from "./LevelFileFormat";

/**
 * Everything needed to initialize a level at runtime: terrain, wave config,
 * and prebuilt wavemesh data.
 */
export interface LoadedLevel extends LevelData {
  wavemeshData: WavefrontMeshData[] | undefined;
  windmeshData: WindMeshFileData | undefined;
}

/**
 * Load a level by name, including its terrain, wave config, and prebuilt
 * wavemesh binary. The wavemesh is fetched asynchronously; if it fails or
 * is missing, `wavemeshData` will be undefined.
 */
export async function loadLevel(levelName: LevelName): Promise<LoadedLevel> {
  const file = validateLevelFile(RESOURCES.levels[levelName]);
  const levelData = levelFileToLevelData(file);

  let wavemeshData: WavefrontMeshData[] | undefined;
  const wavemeshUrl =
    RESOURCES.wavemeshes[levelName as keyof typeof RESOURCES.wavemeshes];
  if (wavemeshUrl) {
    try {
      wavemeshData = await loadWavemeshFromUrl(wavemeshUrl);
      console.log(
        `[LevelLoader] Loaded prebuilt wavemesh for "${levelName}" (${wavemeshData.length} meshes)`,
      );
    } catch (e) {
      console.error(
        `[LevelLoader] Failed to load wavemesh for "${levelName}":`,
        e,
      );
    }
  } else {
    console.warn(
      `[LevelLoader] No wavemesh found for "${levelName}" — run 'npm run build-wavemesh' to generate it`,
    );
  }

  let windmeshData: WindMeshFileData | undefined;
  const windmeshUrl =
    RESOURCES.windmeshes[levelName as keyof typeof RESOURCES.windmeshes];
  if (windmeshUrl) {
    try {
      windmeshData = await loadWindmeshFromUrl(windmeshUrl);
      console.log(`[LevelLoader] Loaded prebuilt windmesh for "${levelName}"`);
    } catch (e) {
      console.error(
        `[LevelLoader] Failed to load windmesh for "${levelName}":`,
        e,
      );
    }
  }

  return { ...levelData, wavemeshData, windmeshData };
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
