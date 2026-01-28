/**
 * Terrain file format and serialization utilities.
 *
 * Defines the JSON schema for terrain files and provides utilities
 * for converting between the file format and game types.
 */

import { V, V2d } from "../../core/Vector";
import {
  createContour,
  TerrainContour,
  TerrainDefinition,
} from "../../game/world/terrain/TerrainTypes";
import { DEFAULT_DEPTH } from "../../game/world-data/terrain/TerrainConstants";

/** Current file format version */
export const TERRAIN_FILE_VERSION = 1;

/**
 * JSON representation of a contour in the file format.
 */
export interface TerrainContourJSON {
  /** Optional human-readable name for the contour */
  name?: string;
  /** Height in feet (negative = underwater, positive = above) */
  height: number;
  /** Control points as [x, y] arrays */
  controlPoints: [number, number][];
}

/**
 * JSON schema for terrain files.
 */
export interface TerrainFileJSON {
  /** File format version */
  version: number;
  /** Deep ocean baseline depth in feet */
  defaultDepth?: number;
  /** Array of terrain contours */
  contours: TerrainContourJSON[];
}

/**
 * Validate a terrain file JSON object.
 * Throws an error if invalid.
 */
export function validateTerrainFile(data: unknown): TerrainFileJSON {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid terrain file: expected object");
  }

  const file = data as Record<string, unknown>;

  if (typeof file.version !== "number") {
    throw new Error("Invalid terrain file: missing or invalid version");
  }

  if (file.version > TERRAIN_FILE_VERSION) {
    throw new Error(
      `Terrain file version ${file.version} is newer than supported version ${TERRAIN_FILE_VERSION}`,
    );
  }

  if (!Array.isArray(file.contours)) {
    throw new Error("Invalid terrain file: contours must be an array");
  }

  for (let i = 0; i < file.contours.length; i++) {
    const contour = file.contours[i];
    if (!contour || typeof contour !== "object") {
      throw new Error(`Invalid terrain file: contour ${i} is not an object`);
    }

    if (typeof contour.height !== "number") {
      throw new Error(`Invalid terrain file: contour ${i} missing height`);
    }

    if (!Array.isArray(contour.controlPoints)) {
      throw new Error(
        `Invalid terrain file: contour ${i} controlPoints must be an array`,
      );
    }

    for (let j = 0; j < contour.controlPoints.length; j++) {
      const pt = contour.controlPoints[j];
      if (!Array.isArray(pt) || pt.length !== 2) {
        throw new Error(
          `Invalid terrain file: contour ${i} point ${j} must be [x, y]`,
        );
      }
      if (typeof pt[0] !== "number" || typeof pt[1] !== "number") {
        throw new Error(
          `Invalid terrain file: contour ${i} point ${j} coordinates must be numbers`,
        );
      }
    }
  }

  return file as unknown as TerrainFileJSON;
}

/**
 * Convert terrain file JSON to game TerrainDefinition.
 */
export function terrainFileToDefinition(
  file: TerrainFileJSON,
): TerrainDefinition {
  const contours: TerrainContour[] = file.contours.map((c) => {
    const controlPoints: V2d[] = c.controlPoints.map(([x, y]) => V(x, y));
    return createContour(controlPoints, c.height);
  });

  return {
    contours,
    defaultDepth: file.defaultDepth ?? DEFAULT_DEPTH,
  };
}

/**
 * Extended contour data that includes the optional name from the file format.
 * Used by the editor to preserve names through edit operations.
 */
export interface EditorContour extends TerrainContour {
  name?: string;
}

/**
 * Editor terrain definition that preserves file format metadata.
 */
export interface EditorTerrainDefinition {
  defaultDepth: number;
  contours: EditorContour[];
}

/**
 * Convert terrain file JSON to editor terrain definition (preserves names).
 */
export function terrainFileToEditorDefinition(
  file: TerrainFileJSON,
): EditorTerrainDefinition {
  const contours: EditorContour[] = file.contours.map((c) => {
    const controlPoints: V2d[] = c.controlPoints.map(([x, y]) => V(x, y));
    return {
      name: c.name,
      controlPoints,
      height: c.height,
    };
  });

  return {
    defaultDepth: file.defaultDepth ?? DEFAULT_DEPTH,
    contours,
  };
}

/**
 * Convert editor terrain definition to file JSON for saving.
 */
export function editorDefinitionToFile(
  definition: EditorTerrainDefinition,
): TerrainFileJSON {
  const contours: TerrainContourJSON[] = definition.contours.map((c) => ({
    name: c.name,
    height: c.height,
    controlPoints: c.controlPoints.map(
      (pt) => [pt.x, pt.y] as [number, number],
    ),
  }));

  return {
    version: TERRAIN_FILE_VERSION,
    defaultDepth: definition.defaultDepth,
    contours,
  };
}

/**
 * Convert game TerrainDefinition to file JSON for saving.
 * Used when exporting from the game.
 */
export function definitionToTerrainFile(
  definition: TerrainDefinition,
): TerrainFileJSON {
  const contours: TerrainContourJSON[] = definition.contours.map((c) => ({
    height: c.height,
    controlPoints: c.controlPoints.map(
      (pt) => [pt.x, pt.y] as [number, number],
    ),
  }));

  return {
    version: TERRAIN_FILE_VERSION,
    defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
    contours,
  };
}

/**
 * Serialize terrain to JSON string.
 */
export function serializeTerrainFile(file: TerrainFileJSON): string {
  return JSON.stringify(file, null, 2);
}

/**
 * Parse JSON string to terrain file.
 */
export function parseTerrainFile(json: string): TerrainFileJSON {
  const data = JSON.parse(json);
  return validateTerrainFile(data);
}

/**
 * Create an empty terrain file.
 */
export function createEmptyTerrainFile(): TerrainFileJSON {
  return {
    version: TERRAIN_FILE_VERSION,
    defaultDepth: DEFAULT_DEPTH,
    contours: [],
  };
}

/**
 * Create an empty editor terrain definition.
 */
export function createEmptyEditorDefinition(): EditorTerrainDefinition {
  return {
    defaultDepth: DEFAULT_DEPTH,
    contours: [],
  };
}
