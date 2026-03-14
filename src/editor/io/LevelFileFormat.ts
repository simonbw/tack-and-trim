/**
 * Level file format and serialization utilities.
 *
 * Defines the JSON schema for level files which contain both terrain
 * and wave configuration data.
 */

import { V, V2d } from "../../core/Vector";
import {
  createContour,
  createPolygonContour,
  TerrainContour,
  TerrainDefinition,
} from "../../game/world/terrain/LandMass";
import { DEFAULT_DEPTH } from "../../game/world/terrain/TerrainConstants";
import {
  WaveConfig,
  WaveSource,
  DEFAULT_WAVE_CONFIG,
} from "../../game/world/water/WaveSource";
import {
  WindConfig,
  DEFAULT_WIND_CONFIG,
} from "../../game/world/wind/WindSource";

// ==========================================
// Editor types
// ==========================================

/**
 * Editor contour data - separate from TerrainContour to avoid requiring
 * pre-sampled polygons during editing. Sampling happens on export to game format.
 */
export interface EditorContour {
  /** Catmull-Rom control points defining the contour (closed loop) */
  readonly controlPoints: readonly V2d[];
  /** Height of this contour in feet (negative = underwater, positive = above water) */
  readonly height: number;
  /** Optional human-readable name for the contour */
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
 * Editor level definition: terrain plus optional wave config.
 */
export interface EditorLevelDefinition {
  terrain: EditorTerrainDefinition;
  waveConfig: WaveConfig | undefined;
  windConfig: WindConfig | undefined;
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

/**
 * Convert editor terrain definition to game TerrainDefinition.
 * This performs spline sampling to create the sampledPolygon for each contour.
 */
export function editorDefinitionToGameDefinition(
  definition: EditorTerrainDefinition,
): TerrainDefinition {
  const contours: TerrainContour[] = definition.contours.map((c) =>
    createContour([...c.controlPoints], c.height),
  );

  return {
    contours,
    defaultDepth: definition.defaultDepth,
  };
}

/** Current file format version */
export const LEVEL_FILE_VERSION = 2;

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
  /** Array of wave source configurations */
  sources: WaveSourceJSON[];
}

/**
 * JSON representation of a wind source in the file format.
 */
export interface WindSourceJSON {
  /** Wind direction in radians */
  direction: number;
}

/**
 * JSON representation of wind configuration in the file format.
 */
export interface WindConfigJSON {
  /** Array of wind source configurations */
  sources: WindSourceJSON[];
}

/**
 * JSON representation of a contour in the file format.
 * A contour has either `controlPoints` (spline) or `polygon` (direct vertices), not both.
 */
export type TerrainContourJSON =
  | {
      /** Optional human-readable name for the contour */
      name?: string;
      /** Height in feet (negative = underwater, positive = above) */
      height: number;
      /** Catmull-Rom spline control points as [x, y] arrays */
      controlPoints: [number, number][];
      polygon?: undefined;
    }
  | {
      /** Optional human-readable name for the contour */
      name?: string;
      /** Height in feet (negative = underwater, positive = above) */
      height: number;
      /** Polygon vertices as [x, y] arrays (used directly, no spline interpolation) */
      polygon: [number, number][];
      controlPoints?: undefined;
    };

/**
 * JSON schema for terrain files (.terrain.json).
 */
export interface TerrainFileJSON {
  /** File format version */
  version: number;
  /** Deep ocean baseline depth in feet */
  defaultDepth?: number;
  /** Array of terrain contours */
  contours: TerrainContourJSON[];
}

/** Magic number for binary terrain files: "TRRN" as little-endian u32. */
const TERRAIN_MAGIC = 0x4e525254;

/** Number of u32 fields per contour in the binary format. */
const BINARY_FLOATS_PER_CONTOUR = 14;

/**
 * Precomputed GPU terrain data parsed from a v2 binary .terrain file.
 * Contains all arrays ready for direct upload to GPU buffers.
 */
export interface PrecomputedTerrainGPUData {
  vertexData: Float32Array;
  contourData: ArrayBuffer;
  childrenData: Uint32Array;
  containmentGridData: Uint32Array;
  idwGridData: Uint32Array;
  lookupGridData: Uint32Array;
  contourCount: number;
  defaultDepth: number;
}

/**
 * Parse result from a v2 binary .terrain file.
 */
export interface TerrainBinaryResult {
  terrainFile: TerrainFileJSON;
  precomputedGPUData: PrecomputedTerrainGPUData;
}

/**
 * Parse a binary .terrain file (v2 or v3 format).
 *
 * v2 binary format (all little-endian):
 *   Header (32 bytes):
 *     magic u32, version u32, defaultDepth f32, contourCount u32,
 *     vertexCount u32, childrenCount u32, containmentGridU32s u32, idwGridU32s u32
 *   Sections:
 *     1. contourData     — contourCount * 14 * 4 bytes
 *     2. vertexData      — vertexCount * 2 * 4 bytes
 *     3. childrenData    — childrenCount * 4 bytes
 *     4. containmentGrid — containmentGridU32s * 4 bytes
 *     5. idwGridData     — idwGridU32s * 4 bytes
 *
 * v3 adds:
 *   Header (36 bytes): + lookupGridU32s u32
 *   Section 6: lookupGridData — lookupGridU32s * 4 bytes
 */
export function parseTerrainBinary(buffer: ArrayBuffer): TerrainBinaryResult {
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== TERRAIN_MAGIC) {
    throw new Error(
      `Invalid terrain file: bad magic 0x${magic.toString(16)} (expected 0x${TERRAIN_MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint32(4, true);
  if (version !== 2 && version !== 3) {
    throw new Error(
      `Unsupported terrain version: ${version} (expected 2 or 3)`,
    );
  }

  const defaultDepth = view.getFloat32(8, true);
  const contourCount = view.getUint32(12, true);
  const vertexCount = view.getUint32(16, true);
  const childrenCount = view.getUint32(20, true);
  const containmentGridU32s = view.getUint32(24, true);
  const idwGridU32s = view.getUint32(28, true);

  let lookupGridU32s = 0;
  let headerSize = 32;
  if (version >= 3) {
    lookupGridU32s = view.getUint32(32, true);
    headerSize = 36;
  }

  let offset = headerSize;

  // Section 1: contourData
  const contourBytes = contourCount * BINARY_FLOATS_PER_CONTOUR * 4;
  const contourData = buffer.slice(offset, offset + contourBytes);
  offset += contourBytes;

  // Section 2: vertexData
  const vertexFloats = vertexCount * 2;
  const vertexData = new Float32Array(buffer, offset, vertexFloats);
  offset += vertexFloats * 4;

  // Section 3: childrenData
  const childrenData = new Uint32Array(buffer, offset, childrenCount);
  offset += childrenCount * 4;

  // Section 4: containmentGrid
  const containmentGridData = new Uint32Array(
    buffer,
    offset,
    containmentGridU32s,
  );
  offset += containmentGridU32s * 4;

  // Section 5: idwGridData
  const idwGridData = new Uint32Array(buffer, offset, idwGridU32s);
  offset += idwGridU32s * 4;

  // Section 6: lookupGridData (v3 only)
  const lookupGridData =
    lookupGridU32s > 0
      ? new Uint32Array(buffer, offset, lookupGridU32s)
      : new Uint32Array(0);

  // Reconstruct TerrainContourJSON[] for CPU-side TerrainDefinition
  const contourView = new DataView(contourData);
  const contours: TerrainContourJSON[] = [];
  for (let i = 0; i < contourCount; i++) {
    const base = i * BINARY_FLOATS_PER_CONTOUR * 4;
    const pointStart = contourView.getUint32(base + 0, true);
    const pointCount = contourView.getUint32(base + 4, true);
    const height = contourView.getFloat32(base + 8, true);

    const polygon: [number, number][] = new Array(pointCount);
    for (let j = 0; j < pointCount; j++) {
      const vi = (pointStart + j) * 2;
      polygon[j] = [vertexData[vi], vertexData[vi + 1]];
    }
    contours.push({ height, polygon });
  }

  return {
    terrainFile: { version, defaultDepth, contours },
    precomputedGPUData: {
      vertexData,
      contourData,
      childrenData,
      containmentGridData,
      idwGridData,
      lookupGridData,
      contourCount,
      defaultDepth,
    },
  };
}

/**
 * JSON representation of tree generation configuration in the file format.
 * All fields are optional and fall back to sensible defaults in the pipeline.
 */
export interface TreeConfigJSON {
  /** Minimum distance between trees in feet (default: 40) */
  spacing?: number;
  /** Fraction of valid positions that get trees, 0–1 (default: 0.7) */
  density?: number;
  /** Minimum terrain elevation for trees in feet (default: 5) */
  minElevation?: number;
  /** Maximum terrain elevation for trees in feet (default: 500) */
  maxElevation?: number;
}

/**
 * JSON schema for level files.
 * v2 allows either inline contours or a terrainFile reference.
 */
export interface LevelFileJSON {
  /** File format version */
  version: number;
  /** Human-readable level name */
  name?: string;
  /** Slug referencing a sibling .terrain.json file (v2) */
  terrainFile?: string;
  /** Deep ocean baseline depth in feet (inline terrain) */
  defaultDepth?: number;
  /** Wave configuration (optional, defaults to DEFAULT_WAVE_CONFIG) */
  waves?: WaveConfigJSON;
  /** Wind configuration (optional, defaults to DEFAULT_WIND_CONFIG) */
  wind?: WindConfigJSON;
  /** Tree generation configuration (optional) */
  trees?: TreeConfigJSON;
  /** Array of terrain contours (optional in v2 if terrainFile is set) */
  contours?: TerrainContourJSON[];
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

  // v2 allows terrainFile instead of inline contours
  if (file.version >= 2 && typeof file.terrainFile === "string") {
    // No inline contours required for v2 with terrainFile
  } else if (!Array.isArray(file.contours)) {
    throw new Error("Invalid level file: contours must be an array");
  }

  // Validate contours if present
  const contours = Array.isArray(file.contours) ? file.contours : [];
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i];
    if (!contour || typeof contour !== "object") {
      throw new Error(`Invalid level file: contour ${i} is not an object`);
    }

    if (typeof contour.height !== "number") {
      throw new Error(`Invalid level file: contour ${i} missing height`);
    }

    const points: unknown[] | undefined =
      contour.polygon ?? contour.controlPoints;
    const pointsKey = contour.polygon ? "polygon" : "controlPoints";

    if (!Array.isArray(points)) {
      throw new Error(
        `Invalid level file: contour ${i} must have controlPoints or polygon array`,
      );
    }

    for (let j = 0; j < points.length; j++) {
      const pt = points[j];
      if (!Array.isArray(pt) || pt.length !== 2) {
        throw new Error(
          `Invalid level file: contour ${i} ${pointsKey}[${j}] must be [x, y]`,
        );
      }
      if (typeof pt[0] !== "number" || typeof pt[1] !== "number") {
        throw new Error(
          `Invalid level file: contour ${i} ${pointsKey}[${j}] coordinates must be numbers`,
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

  // Validate wind if present
  if (file.wind !== undefined) {
    if (!file.wind || typeof file.wind !== "object") {
      throw new Error("Invalid level file: wind must be an object");
    }

    const wind = file.wind as Record<string, unknown>;

    if (!Array.isArray(wind.sources)) {
      throw new Error("Invalid level file: wind.sources must be an array");
    }

    for (let i = 0; i < wind.sources.length; i++) {
      const source = wind.sources[i];
      if (!source || typeof source !== "object") {
        throw new Error(
          `Invalid level file: wind source ${i} is not an object`,
        );
      }

      if (typeof source.direction !== "number") {
        throw new Error(
          `Invalid level file: wind source ${i} missing direction`,
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
 * Ignores legacy fields (primaryDirection, swellCount) if present.
 */
export function waveConfigJSONToWaveConfig(json: WaveConfigJSON): WaveConfig {
  return {
    sources: json.sources.map(waveSourceJSONToWaveSource),
  };
}

/**
 * Convert level file JSON to game TerrainDefinition.
 */
export function levelFileToTerrainDefinition(
  file: LevelFileJSON,
): TerrainDefinition {
  const contours: TerrainContour[] = (file.contours ?? []).map((c) => {
    if (c.polygon) {
      const points: V2d[] = c.polygon.map(([x, y]) => V(x, y));
      return createPolygonContour(points, c.height);
    }
    const controlPoints: V2d[] = c.controlPoints!.map(([x, y]) => V(x, y));
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
 * Validate a terrain file JSON object.
 * Throws an error if invalid.
 */
export function validateTerrainFile(data: unknown): TerrainFileJSON {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid terrain file: expected object");
  }

  const file = data as Record<string, unknown>;

  if (!Array.isArray(file.contours)) {
    throw new Error("Invalid terrain file: contours must be an array");
  }

  return file as unknown as TerrainFileJSON;
}

/**
 * Result of parsing a level file.
 */
export interface LevelData {
  name?: string;
  terrain: TerrainDefinition;
  waves: WaveConfig;
  wind: WindConfig;
}

/**
 * Convert level file JSON to game WindConfig.
 * Returns default config if no wind section present.
 */
export function levelFileToWindConfig(file: LevelFileJSON): WindConfig {
  if (!file.wind) {
    return DEFAULT_WIND_CONFIG;
  }
  return {
    sources: file.wind.sources.map((s) => ({ direction: s.direction })),
  };
}

/**
 * Convert level file JSON to game data structures.
 */
export function levelFileToLevelData(file: LevelFileJSON): LevelData {
  return {
    name: file.name,
    terrain: levelFileToTerrainDefinition(file),
    waves: levelFileToWaveConfig(file),
    wind: levelFileToWindConfig(file),
  };
}

/**
 * Convert game WaveConfig to JSON for saving.
 */
export function waveConfigToJSON(config: WaveConfig): WaveConfigJSON {
  return {
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
 * Convert game WindConfig to JSON for saving.
 */
export function windConfigToJSON(config: WindConfig): WindConfigJSON {
  return {
    sources: config.sources.map((source) => ({
      direction: source.direction,
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

// ==========================================
// Editor conversion functions
// ==========================================

/**
 * Convert level file JSON to editor level definition (preserves names and waves).
 */
export function levelFileToEditorDefinition(
  file: LevelFileJSON,
): EditorLevelDefinition {
  const contours: EditorContour[] = (file.contours ?? []).map((c) => {
    const points = c.polygon ?? c.controlPoints;
    const controlPoints: V2d[] = points.map(([x, y]) => V(x, y));
    return {
      name: c.name,
      controlPoints,
      height: c.height,
    };
  });

  return {
    terrain: {
      defaultDepth: file.defaultDepth ?? DEFAULT_DEPTH,
      contours,
    },
    waveConfig: file.waves ? waveConfigJSONToWaveConfig(file.waves) : undefined,
    windConfig: file.wind
      ? levelFileToWindConfig({ wind: file.wind } as LevelFileJSON)
      : undefined,
  };
}

/**
 * Convert editor level definition to level file JSON for saving.
 */
export function editorDefinitionToLevelFile(
  definition: EditorLevelDefinition,
): LevelFileJSON {
  const contours: TerrainContourJSON[] = definition.terrain.contours.map(
    (c) => ({
      name: c.name,
      height: c.height,
      controlPoints: c.controlPoints.map(
        (pt) => [pt.x, pt.y] as [number, number],
      ),
    }),
  );

  return {
    version: LEVEL_FILE_VERSION,
    defaultDepth: definition.terrain.defaultDepth,
    ...(definition.waveConfig && {
      waves: waveConfigToJSON(definition.waveConfig),
    }),
    ...(definition.windConfig && {
      wind: windConfigToJSON(definition.windConfig),
    }),
    contours,
  };
}

/**
 * Serialize level file to JSON string.
 */
export function serializeLevelFile(file: LevelFileJSON): string {
  return JSON.stringify(file, null, 2);
}
