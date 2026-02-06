/**
 * Level file format and serialization utilities.
 *
 * Defines the JSON schema for level files which contain both terrain
 * and wave configuration data.
 */

import { V, V2d } from "../../core/Vector";
import {
  createContour,
  TerrainContour,
  TerrainDefinition,
} from "../../game/world/terrain/LandMass";
import { DEFAULT_DEPTH } from "../../game/world/terrain/TerrainConstants";
import {
  WaveConfig,
  WaveSource,
  DEFAULT_WAVE_CONFIG,
} from "../../game/world/water/WaveSource";

/** Current file format version */
export const LEVEL_FILE_VERSION = 1;

/**
 * JSON representation of a wave source in the file format.
 */
export interface WaveSourceJSON {
  /** Wave amplitude in feet */
  amplitude: number;
  /** Wavelength in feet */
  wavelength: number;
  /** Wave direction in radians */
  direction: number;
  /** Phase offset in radians (optional, defaults to 0) */
  phaseOffset?: number;
  /** Speed multiplier (optional, defaults to 1.0) */
  speedMult?: number;
  /** Distance to point source (optional, defaults to 1e10 for planar waves) */
  sourceDist?: number;
  /** Point source X offset (optional, defaults to 0) */
  sourceOffsetX?: number;
  /** Point source Y offset (optional, defaults to 0) */
  sourceOffsetY?: number;
}

/**
 * JSON representation of wave configuration in the file format.
 */
export interface WaveConfigJSON {
  /** Primary wave direction for shadow computation (radians) */
  primaryDirection: number;
  /** Number of waves classified as "swell" (rest are "chop") */
  swellCount: number;
  /** Array of wave source configurations */
  sources: WaveSourceJSON[];
}

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
 * JSON schema for level files.
 */
export interface LevelFileJSON {
  /** File format version */
  version: number;
  /** Deep ocean baseline depth in feet */
  defaultDepth?: number;
  /** Wave configuration (optional, defaults to DEFAULT_WAVE_CONFIG) */
  waves?: WaveConfigJSON;
  /** Array of terrain contours */
  contours: TerrainContourJSON[];
}

/**
 * Validate a level file JSON object.
 * Throws an error if invalid.
 */
export function validateLevelFile(data: unknown): LevelFileJSON {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid level file: expected object");
  }

  const file = data as Record<string, unknown>;

  if (typeof file.version !== "number") {
    throw new Error("Invalid level file: missing or invalid version");
  }

  if (file.version > LEVEL_FILE_VERSION) {
    throw new Error(
      `Level file version ${file.version} is newer than supported version ${LEVEL_FILE_VERSION}`,
    );
  }

  if (!Array.isArray(file.contours)) {
    throw new Error("Invalid level file: contours must be an array");
  }

  // Validate contours
  for (let i = 0; i < file.contours.length; i++) {
    const contour = file.contours[i];
    if (!contour || typeof contour !== "object") {
      throw new Error(`Invalid level file: contour ${i} is not an object`);
    }

    if (typeof contour.height !== "number") {
      throw new Error(`Invalid level file: contour ${i} missing height`);
    }

    if (!Array.isArray(contour.controlPoints)) {
      throw new Error(
        `Invalid level file: contour ${i} controlPoints must be an array`,
      );
    }

    for (let j = 0; j < contour.controlPoints.length; j++) {
      const pt = contour.controlPoints[j];
      if (!Array.isArray(pt) || pt.length !== 2) {
        throw new Error(
          `Invalid level file: contour ${i} point ${j} must be [x, y]`,
        );
      }
      if (typeof pt[0] !== "number" || typeof pt[1] !== "number") {
        throw new Error(
          `Invalid level file: contour ${i} point ${j} coordinates must be numbers`,
        );
      }
    }
  }

  // Validate waves if present
  if (file.waves !== undefined) {
    if (!file.waves || typeof file.waves !== "object") {
      throw new Error("Invalid level file: waves must be an object");
    }

    const waves = file.waves as Record<string, unknown>;

    if (typeof waves.primaryDirection !== "number") {
      throw new Error(
        "Invalid level file: waves.primaryDirection must be a number",
      );
    }

    if (typeof waves.swellCount !== "number") {
      throw new Error("Invalid level file: waves.swellCount must be a number");
    }

    if (!Array.isArray(waves.sources)) {
      throw new Error("Invalid level file: waves.sources must be an array");
    }

    for (let i = 0; i < waves.sources.length; i++) {
      const source = waves.sources[i];
      if (!source || typeof source !== "object") {
        throw new Error(
          `Invalid level file: wave source ${i} is not an object`,
        );
      }

      if (typeof source.amplitude !== "number") {
        throw new Error(
          `Invalid level file: wave source ${i} missing amplitude`,
        );
      }

      if (typeof source.wavelength !== "number") {
        throw new Error(
          `Invalid level file: wave source ${i} missing wavelength`,
        );
      }

      if (typeof source.direction !== "number") {
        throw new Error(
          `Invalid level file: wave source ${i} missing direction`,
        );
      }
    }
  }

  return file as unknown as LevelFileJSON;
}

/**
 * Convert wave source JSON to game WaveSource.
 */
function waveSourceJSONToWaveSource(json: WaveSourceJSON): WaveSource {
  return {
    amplitude: json.amplitude,
    wavelength: json.wavelength,
    direction: json.direction,
    phaseOffset: json.phaseOffset ?? 0,
    speedMult: json.speedMult ?? 1.0,
    sourceDist: json.sourceDist ?? 1e10,
    sourceOffsetX: json.sourceOffsetX ?? 0,
    sourceOffsetY: json.sourceOffsetY ?? 0,
  };
}

/**
 * Convert wave config JSON to game WaveConfig.
 */
export function waveConfigJSONToWaveConfig(json: WaveConfigJSON): WaveConfig {
  return {
    primaryDirection: json.primaryDirection,
    swellCount: json.swellCount,
    sources: json.sources.map(waveSourceJSONToWaveSource),
  };
}

/**
 * Convert level file JSON to game TerrainDefinition.
 */
export function levelFileToTerrainDefinition(
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
 * Convert level file JSON to game WaveConfig.
 * Returns default config if no waves section present.
 */
export function levelFileToWaveConfig(file: LevelFileJSON): WaveConfig {
  if (!file.waves) {
    return DEFAULT_WAVE_CONFIG;
  }
  return waveConfigJSONToWaveConfig(file.waves);
}

/**
 * Result of parsing a level file.
 */
export interface LevelData {
  terrain: TerrainDefinition;
  waves: WaveConfig;
}

/**
 * Convert level file JSON to game data structures.
 */
export function levelFileToLevelData(file: LevelFileJSON): LevelData {
  return {
    terrain: levelFileToTerrainDefinition(file),
    waves: levelFileToWaveConfig(file),
  };
}

/**
 * Convert game WaveConfig to JSON for saving.
 */
export function waveConfigToJSON(config: WaveConfig): WaveConfigJSON {
  return {
    primaryDirection: config.primaryDirection,
    swellCount: config.swellCount,
    sources: config.sources.map((source) => ({
      amplitude: source.amplitude,
      wavelength: source.wavelength,
      direction: source.direction,
      // Only include optional fields if they differ from defaults
      ...(source.phaseOffset !== 0 && { phaseOffset: source.phaseOffset }),
      ...(source.speedMult !== 1.0 && { speedMult: source.speedMult }),
      ...(source.sourceDist !== 1e10 && { sourceDist: source.sourceDist }),
      ...(source.sourceOffsetX !== 0 && {
        sourceOffsetX: source.sourceOffsetX,
      }),
      ...(source.sourceOffsetY !== 0 && {
        sourceOffsetY: source.sourceOffsetY,
      }),
    })),
  };
}

/**
 * Parse JSON string to level file.
 */
export function parseLevelFile(json: string): LevelFileJSON {
  const data = JSON.parse(json);
  return validateLevelFile(data);
}
