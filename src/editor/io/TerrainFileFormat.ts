/**
 * Terrain file format and serialization utilities.
 *
 * Defines the JSON schema for terrain files and provides utilities
 * for converting between the file format and game types.
 */

import { V, V2d } from "../../core/Vector";
import { DEFAULT_DEPTH } from "../../game/world/terrain/TerrainConstants";
import {
  createContour,
  TerrainContour,
  TerrainDefinition,
} from "../../game/world/terrain/TerrainTypes";

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
export interface LevelFileJSON {
  /** File format version */
  version: number;
  /** Deep ocean baseline depth in feet */
  defaultDepth?: number;
  /** Array of terrain contours */
  contours: TerrainContourJSON[];
  /** Base wind velocity (m/s) */
  baseWind?: {
    x: number;
    y: number;
  };
  /** Water system configuration */
  water?: {
    waves?: Array<{
      direction: number; // radians (0 = east, π/2 = north)
      amplitude: number; // meters
      wavelength: number; // meters
    }>;
    tide?: {
      amplitude: number; // meters
      period: number; // seconds
    };
  };
}

/**
 * Validate a terrain file JSON object.
 * Throws an error if invalid.
 */
export function validateLevelFile(data: unknown): LevelFileJSON {
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

  // Validate optional baseWind field
  if (file.baseWind !== undefined) {
    if (typeof file.baseWind !== "object" || file.baseWind === null) {
      throw new Error("Invalid terrain file: baseWind must be an object");
    }
    const baseWind = file.baseWind as Record<string, unknown>;
    if (typeof baseWind.x !== "number" || typeof baseWind.y !== "number") {
      throw new Error(
        "Invalid terrain file: baseWind must have numeric x and y fields",
      );
    }
  }

  // Validate optional water field
  if (file.water !== undefined) {
    if (typeof file.water !== "object" || file.water === null) {
      throw new Error("Invalid terrain file: water must be an object");
    }
    const water = file.water as Record<string, unknown>;

    // Validate optional waves array
    if (water.waves !== undefined) {
      if (!Array.isArray(water.waves)) {
        throw new Error("Invalid terrain file: water.waves must be an array");
      }

      for (let i = 0; i < water.waves.length; i++) {
        const wave = water.waves[i];
        if (typeof wave !== "object" || wave === null) {
          throw new Error(
            `Invalid terrain file: water.waves[${i}] must be an object`,
          );
        }
        const waveObj = wave as Record<string, unknown>;
        if (
          typeof waveObj.direction !== "number" ||
          typeof waveObj.amplitude !== "number" ||
          typeof waveObj.wavelength !== "number"
        ) {
          throw new Error(
            `Invalid terrain file: water.waves[${i}] must have numeric direction, amplitude, and wavelength`,
          );
        }
      }
    }

    // Validate optional tide
    if (water.tide !== undefined) {
      if (typeof water.tide !== "object" || water.tide === null) {
        throw new Error("Invalid terrain file: water.tide must be an object");
      }
      const tide = water.tide as Record<string, unknown>;
      if (
        typeof tide.amplitude !== "number" ||
        typeof tide.period !== "number"
      ) {
        throw new Error(
          "Invalid terrain file: water.tide must have numeric amplitude and period",
        );
      }
    }
  }

  return file as unknown as LevelFileJSON;
}

/**
 * Convert terrain file JSON to game TerrainDefinition.
 */
export function terrainFileToDefinition(
  file: LevelFileJSON,
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
 * Editor level definition that preserves file format metadata.
 */
export interface EditorLevelDefinition {
  defaultDepth: number;
  contours: EditorContour[];
  /** Base wind velocity (m/s) */
  baseWind?: {
    x: number;
    y: number;
  };
  /** Water system configuration */
  water?: {
    waves?: Array<{
      direction: number;
      amplitude: number;
      wavelength: number;
    }>;
    tide?: {
      amplitude: number;
      period: number;
    };
  };
}

/**
 * Convert level file JSON to editor level definition (preserves names).
 */
export function levelFileToEditorDefinition(
  file: LevelFileJSON,
): EditorLevelDefinition {
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
    baseWind: file.baseWind,
    water: file.water,
  };
}

/**
 * Convert editor level definition to file JSON for saving.
 */
export function editorDefinitionToFile(
  definition: EditorLevelDefinition,
): LevelFileJSON {
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
    baseWind: definition.baseWind,
    water: definition.water,
  };
}

/**
 * Convert game TerrainDefinition to file JSON for saving.
 * Used when exporting from the game.
 */
export function definitionToTerrainFile(
  definition: TerrainDefinition,
): LevelFileJSON {
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
export function serializeTerrainFile(file: LevelFileJSON): string {
  return JSON.stringify(file, null, 2);
}

/**
 * Parse JSON string to terrain file.
 */
export function parseTerrainFile(json: string): LevelFileJSON {
  const data = JSON.parse(json);
  return validateLevelFile(data);
}

/**
 * Create an empty terrain file.
 */
export function createEmptyTerrainFile(): LevelFileJSON {
  return {
    version: TERRAIN_FILE_VERSION,
    defaultDepth: DEFAULT_DEPTH,
    contours: [],
  };
}

/**
 * Create an empty editor level definition.
 */
export function createEmptyEditorDefinition(): EditorLevelDefinition {
  return {
    defaultDepth: DEFAULT_DEPTH,
    contours: [],
    baseWind: { x: 5, y: 0 }, // Default: 5 m/s from the west
    water: {
      waves: [
        { direction: 0, amplitude: 0.5, wavelength: 20 }, // Primary wave
        { direction: Math.PI / 4, amplitude: 0.3, wavelength: 15 }, // Secondary wave
      ],
    },
  };
}
