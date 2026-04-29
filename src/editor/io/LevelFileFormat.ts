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
import type { WeatherStateConfig } from "../../game/weather/WeatherState";
import type { WeatherVariability } from "../../game/weather/WeatherDirector";

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
  biome?: BiomeConfigJSON;
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
 * JSON representation of per-level weather settings.
 * All fields optional; omitted fields fall back to engine defaults.
 */
export interface WeatherConfigJSON {
  /** Wind direction in radians. Combined with `windSpeed` to build windBase. */
  windDirection?: number;
  /** Wind speed in ft/s (default 11). */
  windSpeed?: number;
  /** Cloud cover 0..1. */
  cloudCover?: number;
  /** Rain intensity 0..1. */
  rainIntensity?: number;
  /** Multiplier on Gerstner wave amplitude (default 1). */
  waveAmplitudeScale?: number;
  /** Gust strength 0..1. */
  gustiness?: number;
  /** Slow-drift weather modulation ranges (deviation from baseline, 0..1). */
  variability?: {
    cloudCoverRange?: number;
    rainIntensityRange?: number;
    gustinessRange?: number;
  };
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
 * JSON representation of a biome elevation zone.
 */
export interface BiomeZoneJSON {
  /** Upper height bound in feet for this zone */
  maxHeight: number;
  /** Base RGB color [0-1] */
  color: [number, number, number];
  /** Alternate RGB color for noise variation [0-1] */
  colorAlt: [number, number, number];
  /** How much noise blends between color and colorAlt (0-1) */
  noiseBlend: number;
  /** Tree density override for this zone, 0-1. Omit to use global trees.density. */
  treeDensity?: number;
}

/**
 * Geographic bounding box for region terrain extraction.
 */
export interface BoundingBoxJSON {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * A positive quantity that may vary with elevation.
 *
 * Either a bare number (uniform at all elevations) or an array of
 * `[height_ft, value]` breakpoints sorted by height ascending. The pipeline
 * looks up `interval` piecewise-constant and `simplify` piecewise-linear.
 */
export type ElevationScheduleJSON = number | [number, number][];

/**
 * Region configuration for terrain extraction from elevation data.
 * Embedded in the level file to define how terrain is built from geographic data.
 *
 * Bounds can be specified as either a rectangular `bbox` or a convex `bounds`
 * polygon (array of `[lat, lon]` pairs). Exactly one must be present.
 */
export interface RegionConfigJSON {
  datasetPath?: string;
  dataSource?: {
    type: string;
    [key: string]: unknown;
  };
  /** Axis-aligned bounding box. Mutually exclusive with `bounds`. */
  bbox?: BoundingBoxJSON;
  /** Convex polygon as `[lat, lon]` vertices. Mutually exclusive with `bbox`. */
  bounds?: [number, number][];
  /** Contour spacing in feet. Scalar for uniform, schedule for elevation-dependent. */
  interval: ElevationScheduleJSON;
  /** Polygon simplification tolerance in feet. Scalar or elevation schedule. */
  simplify: ElevationScheduleJSON;
  scale: number;
  minPerimeter: number;
  minPoints: number;
  flipY: boolean;
}

/**
 * JSON representation of biome terrain coloring configuration.
 * Defines how terrain surfaces are colored based on elevation, slope, and noise.
 */
export interface BiomeConfigJSON {
  /** Elevation zones sorted by maxHeight, up to 6 */
  zones: BiomeZoneJSON[];
  /** RGB color for exposed rock on steep slopes [0-1] */
  rockColor: [number, number, number];
  /** Slope value (0-1) above which rock appears (0 = always rock, 1 = never) */
  rockThreshold: number;
  /** RGB color for snow (default: [0.95, 0.97, 1.0]) */
  snowColor?: [number, number, number];
  /** Height above which snow appears, -1 = no snow (default: -1) */
  snowlineHeight?: number;
  /** World units per noise cycle for large patches (default: 0.005) */
  largeNoiseScale?: number;
  /** World units per noise cycle for fine detail (default: 0.3) */
  smallNoiseScale?: number;
}

/**
 * JSON representation of a port (dock/harbor) in the file format.
 */
export interface PortJSON {
  /** Unique identifier for this port */
  id: string;
  /** Human-readable port name */
  name: string;
  /** World coordinates in feet */
  position: [number, number];
  /** Dock orientation in radians */
  angle: number;
}

/**
 * JSON representation of a mission definition in the file format.
 */
export interface MissionDefJSON {
  /** Unique identifier for this mission */
  id: string;
  /** Human-readable mission name */
  name: string;
  /** Description shown to the player */
  description: string;
  /** Mission type */
  type: "delivery";
  /** Port where cargo is picked up */
  sourcePortId: string;
  /** Port where cargo is delivered */
  destinationPortId: string;
  /** Requirements to unlock this mission */
  prerequisites: {
    /** Mission IDs that must be completed first */
    completedMissions?: string[];
    /** Minimum money required */
    money?: number;
  };
  /** What the player receives on completion */
  rewards: {
    /** Money earned */
    money?: number;
    /** Port IDs to reveal on the map */
    revealPorts?: string[];
  };
}

/**
 * Display metadata shown on the new-game map selection screen.
 * All fields optional; the menu renders only the ones that are present.
 */
export interface LevelDisplayInfo {
  /** Short description shown on the map selection screen (1-2 sentences) */
  description?: string;
  /** Difficulty rating rendered as a badge */
  difficulty?: "beginner" | "intermediate" | "expert";
}

/**
 * JSON schema for level files.
 * v2 allows either inline contours or a region config (external terrain).
 */
export interface LevelFileJSON {
  /** File format version */
  version: number;
  /** Human-readable level name */
  name?: string;
  /** Display metadata for the map selection screen */
  displayInfo?: LevelDisplayInfo;
  /** Region config for terrain extraction (presence implies external .terrain binary) */
  region?: RegionConfigJSON;
  /** Deep ocean baseline depth in feet (inline terrain) */
  defaultDepth?: number;
  /** Wave configuration (optional, defaults to DEFAULT_WAVE_CONFIG) */
  waves?: WaveConfigJSON;
  /** Wind configuration (optional, defaults to DEFAULT_WIND_CONFIG) */
  wind?: WindConfigJSON;
  /** Per-level weather config (cloud cover, rain, gustiness, variability) */
  weather?: WeatherConfigJSON;
  /** Tree generation configuration (optional) */
  trees?: TreeConfigJSON;
  /** Biome terrain coloring configuration (optional) */
  biome?: BiomeConfigJSON;
  /** Boat start position as [x, y] in world coordinates (optional, defaults to [0, 0]) */
  startPosition?: [number, number];
  /** Port where the player starts a new game */
  startingPortId?: string;
  /** Array of terrain contours (optional in v2 if region is set) */
  contours?: TerrainContourJSON[];
  /** Ports (docks/harbors) in this level */
  ports?: PortJSON[];
  /** Mission definitions for the progression system */
  missions?: MissionDefJSON[];
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

  // v2 allows region instead of inline contours
  if (file.version >= 2 && file.region != null) {
    // No inline contours required for v2 with region
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

  // Validate weather if present
  if (file.weather !== undefined) {
    if (!file.weather || typeof file.weather !== "object") {
      throw new Error("Invalid level file: weather must be an object");
    }
    const weather = file.weather as Record<string, unknown>;
    const numericFields: ReadonlyArray<keyof WeatherConfigJSON> = [
      "windDirection",
      "windSpeed",
      "cloudCover",
      "rainIntensity",
      "waveAmplitudeScale",
      "gustiness",
    ];
    for (const field of numericFields) {
      const v = weather[field];
      if (v !== undefined && typeof v !== "number") {
        throw new Error(
          `Invalid level file: weather.${field} must be a number`,
        );
      }
    }
    const unitFields: ReadonlyArray<keyof WeatherConfigJSON> = [
      "cloudCover",
      "rainIntensity",
      "gustiness",
    ];
    for (const field of unitFields) {
      const v = weather[field] as number | undefined;
      if (v !== undefined && (v < 0 || v > 1)) {
        throw new Error(
          `Invalid level file: weather.${field} must be in [0, 1]`,
        );
      }
    }
    if (weather.variability !== undefined) {
      if (!weather.variability || typeof weather.variability !== "object") {
        throw new Error(
          "Invalid level file: weather.variability must be an object",
        );
      }
      const variability = weather.variability as Record<string, unknown>;
      const variabilityFields = [
        "cloudCoverRange",
        "rainIntensityRange",
        "gustinessRange",
      ] as const;
      for (const field of variabilityFields) {
        const v = variability[field];
        if (v !== undefined) {
          if (typeof v !== "number") {
            throw new Error(
              `Invalid level file: weather.variability.${field} must be a number`,
            );
          }
          if (v < 0 || v > 1) {
            throw new Error(
              `Invalid level file: weather.variability.${field} must be in [0, 1]`,
            );
          }
        }
      }
    }
  }

  // Validate ports if present
  if (file.ports !== undefined) {
    if (!Array.isArray(file.ports)) {
      throw new Error("Invalid level file: ports must be an array");
    }

    const portIds = new Set<string>();
    for (let i = 0; i < file.ports.length; i++) {
      const port = file.ports[i] as Record<string, unknown>;
      if (!port || typeof port !== "object") {
        throw new Error(`Invalid level file: port ${i} is not an object`);
      }
      if (typeof port.id !== "string" || port.id.length === 0) {
        throw new Error(`Invalid level file: port ${i} missing or empty id`);
      }
      if (portIds.has(port.id as string)) {
        throw new Error(`Invalid level file: duplicate port id "${port.id}"`);
      }
      portIds.add(port.id as string);
      if (typeof port.name !== "string") {
        throw new Error(`Invalid level file: port ${i} missing name`);
      }
      if (
        !Array.isArray(port.position) ||
        port.position.length !== 2 ||
        typeof port.position[0] !== "number" ||
        typeof port.position[1] !== "number"
      ) {
        throw new Error(
          `Invalid level file: port ${i} position must be [x, y]`,
        );
      }
      if (typeof port.angle !== "number") {
        throw new Error(`Invalid level file: port ${i} missing angle`);
      }
    }

    // Validate startingPortId references a valid port
    if (
      typeof file.startingPortId === "string" &&
      !portIds.has(file.startingPortId)
    ) {
      throw new Error(
        `Invalid level file: startingPortId "${file.startingPortId}" does not match any port id`,
      );
    }
  }

  // Validate missions if present
  if (file.missions !== undefined) {
    if (!Array.isArray(file.missions)) {
      throw new Error("Invalid level file: missions must be an array");
    }

    // Collect port IDs for cross-reference validation
    const portIds = new Set<string>(
      Array.isArray(file.ports)
        ? (file.ports as Array<Record<string, unknown>>).map(
            (p) => p.id as string,
          )
        : [],
    );

    const missionIds = new Set<string>();
    for (let i = 0; i < file.missions.length; i++) {
      const mission = file.missions[i] as Record<string, unknown>;
      if (!mission || typeof mission !== "object") {
        throw new Error(`Invalid level file: mission ${i} is not an object`);
      }
      if (typeof mission.id !== "string" || mission.id.length === 0) {
        throw new Error(`Invalid level file: mission ${i} missing or empty id`);
      }
      if (missionIds.has(mission.id as string)) {
        throw new Error(
          `Invalid level file: duplicate mission id "${mission.id}"`,
        );
      }
      missionIds.add(mission.id as string);
      if (typeof mission.name !== "string") {
        throw new Error(`Invalid level file: mission ${i} missing name`);
      }
      if (typeof mission.description !== "string") {
        throw new Error(`Invalid level file: mission ${i} missing description`);
      }
      if (mission.type !== "delivery") {
        throw new Error(
          `Invalid level file: mission ${i} has invalid type "${mission.type}" (expected "delivery")`,
        );
      }
      if (typeof mission.sourcePortId !== "string") {
        throw new Error(
          `Invalid level file: mission ${i} missing sourcePortId`,
        );
      }
      if (portIds.size > 0 && !portIds.has(mission.sourcePortId as string)) {
        throw new Error(
          `Invalid level file: mission ${i} sourcePortId "${mission.sourcePortId}" does not match any port id`,
        );
      }
      if (typeof mission.destinationPortId !== "string") {
        throw new Error(
          `Invalid level file: mission ${i} missing destinationPortId`,
        );
      }
      if (
        portIds.size > 0 &&
        !portIds.has(mission.destinationPortId as string)
      ) {
        throw new Error(
          `Invalid level file: mission ${i} destinationPortId "${mission.destinationPortId}" does not match any port id`,
        );
      }
      if (
        mission.prerequisites != null &&
        typeof mission.prerequisites !== "object"
      ) {
        throw new Error(
          `Invalid level file: mission ${i} prerequisites must be an object`,
        );
      }
      if (mission.rewards != null && typeof mission.rewards !== "object") {
        throw new Error(
          `Invalid level file: mission ${i} rewards must be an object`,
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
 * Runtime port data with V2d position.
 */
export interface PortData {
  /** Unique identifier for this port */
  id: string;
  /** Human-readable port name */
  name: string;
  /** World position in feet */
  position: V2d;
  /** Dock orientation in radians */
  angle: number;
}

/**
 * Runtime mission definition.
 * Mirrors MissionDefJSON — no coordinate conversions needed.
 */
export interface MissionDef {
  /** Unique identifier for this mission */
  id: string;
  /** Human-readable mission name */
  name: string;
  /** Description shown to the player */
  description: string;
  /** Mission type */
  type: "delivery";
  /** Port where cargo is picked up */
  sourcePortId: string;
  /** Port where cargo is delivered */
  destinationPortId: string;
  /** Requirements to unlock this mission */
  prerequisites: {
    /** Mission IDs that must be completed first */
    completedMissions?: string[];
    /** Minimum money required */
    money?: number;
  };
  /** What the player receives on completion */
  rewards: {
    /** Money earned */
    money?: number;
    /** Port IDs to reveal on the map */
    revealPorts?: string[];
  };
}

/**
 * Runtime weather data parsed from a level file.
 */
export interface WeatherLevelData {
  config: WeatherStateConfig;
  variability: WeatherVariability;
}

/**
 * Result of parsing a level file.
 */
export interface LevelData {
  name?: string;
  terrain: TerrainDefinition;
  waves: WaveConfig;
  wind: WindConfig;
  biome?: BiomeConfigJSON;
  startPosition?: V2d;
  /** Port where the player starts a new game */
  startingPortId?: string;
  /** Ports (docks/harbors) in this level */
  ports?: PortData[];
  /** Mission definitions for the progression system */
  missions?: MissionDef[];
  /** Per-level weather (omitted if level has no weather block) */
  weather?: WeatherLevelData;
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
 * Convert port JSON to runtime PortData.
 */
function portJSONToPortData(json: PortJSON): PortData {
  return {
    id: json.id,
    name: json.name,
    position: V(json.position[0], json.position[1]),
    angle: json.angle,
  };
}

/**
 * Convert mission def JSON to runtime MissionDef.
 */
function missionDefJSONToMissionDef(json: MissionDefJSON): MissionDef {
  return {
    id: json.id,
    name: json.name,
    description: json.description,
    type: json.type,
    sourcePortId: json.sourcePortId,
    destinationPortId: json.destinationPortId,
    prerequisites: {
      ...(json.prerequisites.completedMissions && {
        completedMissions: [...json.prerequisites.completedMissions],
      }),
      ...(json.prerequisites.money != null && {
        money: json.prerequisites.money,
      }),
    },
    rewards: {
      ...(json.rewards.money != null && { money: json.rewards.money }),
      ...(json.rewards.revealPorts && {
        revealPorts: [...json.rewards.revealPorts],
      }),
    },
  };
}

/** Default wind speed (ft/s) when only `windDirection` is given. */
const DEFAULT_WEATHER_WIND_SPEED = 11;

/**
 * Convert weather JSON to runtime data, deriving `windBase` from
 * `windDirection`/`windSpeed` (or from the wind block) if present. Returns
 * `undefined` when no weather block is present so callers can fall back to
 * engine defaults.
 */
export function levelFileToWeatherData(
  file: LevelFileJSON,
): WeatherLevelData | undefined {
  if (!file.weather) return undefined;
  const w = file.weather;

  let direction = w.windDirection;
  if (direction === undefined && file.wind?.sources?.[0]) {
    direction = file.wind.sources[0].direction;
  }
  let windBase: V2d | undefined;
  if (direction !== undefined || w.windSpeed !== undefined) {
    const dir = direction ?? 0;
    const speed = w.windSpeed ?? DEFAULT_WEATHER_WIND_SPEED;
    windBase = V(Math.cos(dir) * speed, Math.sin(dir) * speed);
  }

  const config: WeatherStateConfig = {
    ...(windBase && { windBase }),
    ...(w.cloudCover !== undefined && { cloudCover: w.cloudCover }),
    ...(w.rainIntensity !== undefined && { rainIntensity: w.rainIntensity }),
    ...(w.waveAmplitudeScale !== undefined && {
      waveAmplitudeScale: w.waveAmplitudeScale,
    }),
    ...(w.gustiness !== undefined && { gustiness: w.gustiness }),
  };
  const variability: WeatherVariability = { ...w.variability };
  return { config, variability };
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
    biome: file.biome,
    startPosition: file.startPosition
      ? V(file.startPosition[0], file.startPosition[1])
      : undefined,
    startingPortId: file.startingPortId,
    ports: file.ports?.map(portJSONToPortData),
    missions: file.missions?.map(missionDefJSONToMissionDef),
    weather: levelFileToWeatherData(file),
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
    biome: file.biome,
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
    ...(definition.biome && { biome: definition.biome }),
    contours,
  };
}

/**
 * Serialize level file to JSON string.
 */
export function serializeLevelFile(file: LevelFileJSON): string {
  return JSON.stringify(file, null, 2);
}
