/**
 * Level loader utility.
 *
 * Provides functions for loading level data (terrain + waves + wavemesh) from
 * bundled resources. Used by both the editor and the game.
 */

import type { WavefrontMeshData } from "../../pipeline/mesh-building/MeshBuildTypes";
import type { TreeFileData } from "../../pipeline/mesh-building/TreeFile";
import type { WindMeshFileBundle } from "../../pipeline/mesh-building/WindmeshFile";
import { loadWavemeshFromUrl } from "../../game/wave-physics/WavemeshLoader";
import { loadWindmeshFromUrl } from "../../game/wind/WindmeshLoader";
import { loadTreesFromUrl } from "../../game/trees/TreeLoader";
import { RESOURCES, LevelName } from "../../../resources/resources";
import type { PrecomputedTerrainGPUData } from "./LevelFileFormat";
import {
  EditorLevelDefinition,
  LevelData,
  LevelFileJSON,
  levelFileToEditorDefinition,
  levelFileToLevelData,
  parseTerrainBinary,
  parseLevelFile,
  validateLevelFile,
} from "./LevelFileFormat";

/**
 * Resolve terrain references in a v2 level file.
 * If the level has a region config, fetch and merge the binary terrain data.
 * Returns the updated file and any precomputed GPU data.
 */
async function resolveTerrainReference(
  file: LevelFileJSON,
  levelName: string,
): Promise<{
  file: LevelFileJSON;
  precomputedGPUData: PrecomputedTerrainGPUData | undefined;
}> {
  if (!file.region) {
    return { file, precomputedGPUData: undefined };
  }

  const terrainKey = levelName as keyof typeof RESOURCES.terrains;
  const terrainUrl = RESOURCES.terrains[terrainKey];
  if (!terrainUrl) {
    throw new Error(
      `Terrain binary for level "${levelName}" not found in resources`,
    );
  }

  const response = await fetch(terrainUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch terrain: ${response.status} ${terrainUrl}`,
    );
  }
  const buffer = await response.arrayBuffer();
  const result = parseTerrainBinary(buffer);

  return {
    file: {
      ...file,
      defaultDepth: file.defaultDepth ?? result.terrainFile.defaultDepth,
      contours: result.terrainFile.contours,
    },
    precomputedGPUData: result.precomputedGPUData,
  };
}

/**
 * Everything needed to initialize a level at runtime: terrain, wave config,
 * wind config, and prebuilt mesh data.
 */
export interface LoadedLevel extends LevelData {
  wavemeshData: WavefrontMeshData[] | undefined;
  windmeshData: WindMeshFileBundle | undefined;
  treeData: TreeFileData | undefined;
}

/**
 * Load a level by name, including its terrain, wave config, and prebuilt
 * wavemesh binary. The wavemesh is fetched asynchronously; if it fails or
 * is missing, `wavemeshData` will be undefined.
 */
export async function loadLevel(levelName: LevelName): Promise<LoadedLevel> {
  const rawFile = validateLevelFile(RESOURCES.levels[levelName]);
  const { file, precomputedGPUData } = await resolveTerrainReference(
    rawFile,
    levelName,
  );
  const levelData = levelFileToLevelData(file);
  if (precomputedGPUData) {
    levelData.terrain.precomputedGPUData = precomputedGPUData;
  }

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

  let treeData: TreeFileData | undefined;
  const treesUrl = RESOURCES.trees[levelName as keyof typeof RESOURCES.trees];
  if (treesUrl) {
    try {
      treeData = await loadTreesFromUrl(treesUrl);
      console.log(
        `[LevelLoader] Loaded tree data for "${levelName}" (${treeData.positions.length} trees)`,
      );
    } catch (e) {
      console.error(
        `[LevelLoader] Failed to load tree data for "${levelName}":`,
        e,
      );
    }
  }

  return { ...levelData, wavemeshData, windmeshData, treeData };
}

/**
 * Load the default level for editor (preserves names and wave config).
 * Uses the bundled resource from the asset system.
 */
export async function loadDefaultEditorLevel(): Promise<EditorLevelDefinition> {
  const rawFile = validateLevelFile(RESOURCES.levels.default);
  const { file } = await resolveTerrainReference(rawFile, "default");
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
