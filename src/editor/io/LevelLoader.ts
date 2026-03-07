/**
 * Level loader utility.
 *
 * Provides functions for loading level data (terrain + waves + wavemesh) from
 * bundled resources. Used by both the editor and the game.
 */

import type { WavefrontMeshData } from "../../pipeline/mesh-building/MeshBuildTypes";
import type { WindMeshFileBundle } from "../../pipeline/mesh-building/WindmeshFile";
import { loadWavemeshFromUrl } from "../../game/wave-physics/WavemeshLoader";
import { loadWindmeshFromUrl } from "../../game/wind/WindmeshLoader";
import { RESOURCES, LevelName } from "../../../resources/resources";
import {
  EditorLevelDefinition,
  LevelData,
  LevelFileJSON,
  TerrainFileJSON,
  levelFileToEditorDefinition,
  levelFileToLevelData,
  parseLevelFile,
  validateLevelFile,
  validateTerrainFile,
} from "./LevelFileFormat";

/**
 * Resolve terrain references in a v2 level file.
 * If the level has a terrainFile reference, merge the terrain data into it.
 */
function resolveTerrainReference(file: LevelFileJSON): LevelFileJSON {
  if (!file.terrainFile) {
    return file;
  }

  const terrainKey = file.terrainFile.replace(
    /-([a-z])/g,
    (_: string, c: string) => c.toUpperCase(),
  ) as keyof typeof RESOURCES.terrains;
  const terrainData = RESOURCES.terrains[terrainKey];
  if (!terrainData) {
    throw new Error(
      `Terrain file "${file.terrainFile}" not found in resources`,
    );
  }

  const terrain = validateTerrainFile(terrainData);
  return {
    ...file,
    defaultDepth: file.defaultDepth ?? terrain.defaultDepth,
    contours: terrain.contours,
  };
}

/**
 * Everything needed to initialize a level at runtime: terrain, wave config,
 * wind config, and prebuilt mesh data.
 */
export interface LoadedLevel extends LevelData {
  wavemeshData: WavefrontMeshData[] | undefined;
  windmeshData: WindMeshFileBundle | undefined;
}

/**
 * Load a level by name, including its terrain, wave config, and prebuilt
 * wavemesh binary. The wavemesh is fetched asynchronously; if it fails or
 * is missing, `wavemeshData` will be undefined.
 */
export async function loadLevel(levelName: LevelName): Promise<LoadedLevel> {
  const rawFile = validateLevelFile(RESOURCES.levels[levelName]);
  const file = resolveTerrainReference(rawFile);
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

  let windmeshData: WindMeshFileBundle | undefined;
  const windmeshUrl =
    RESOURCES.windmeshes[levelName as keyof typeof RESOURCES.windmeshes];
  if (windmeshUrl) {
    try {
      windmeshData = await loadWindmeshFromUrl(windmeshUrl);
      console.log(
        `[LevelLoader] Loaded prebuilt windmesh for "${levelName}" (${windmeshData.sourceCount} sources)`,
      );
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
  const rawFile = validateLevelFile(RESOURCES.levels.default);
  const file = resolveTerrainReference(rawFile);
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
