import { V2d } from "../../core/Vector";
import {
  DEFAULT_BEACH_WIDTH,
  DEFAULT_HILL_AMPLITUDE,
  DEFAULT_HILL_FREQUENCY,
  DEFAULT_PEAK_HEIGHT,
} from "./TerrainConstants";

/**
 * Defines a single land mass using Catmull-Rom splines for smooth coastlines.
 */
export interface LandMass {
  /** Catmull-Rom control points defining coastline (closed loop) */
  readonly controlPoints: readonly V2d[];

  /** Max height above water (ft), e.g., 3-8 ft for sandy islands */
  readonly peakHeight: number;

  /** Distance from shore where terrain starts rising (ft), e.g., 15-30 ft */
  readonly beachWidth: number;

  /** Noise spatial scale for rolling hills */
  readonly hillFrequency: number;

  /** Height variation as fraction of peakHeight */
  readonly hillAmplitude: number;
}

/**
 * Collection of land masses defining the terrain for a level.
 */
export interface TerrainDefinition {
  landMasses: LandMass[];
}

/**
 * GPU buffer layout for a single land mass.
 * Must match the WGSL struct layout.
 */
export interface LandMassGPUData {
  startIndex: number; // Index into control points buffer
  pointCount: number; // Number of control points
  peakHeight: number;
  beachWidth: number;
  hillFrequency: number;
  hillAmplitude: number;
}

/** Number of float32 values per land mass in GPU buffer (6 values + 2 padding for alignment) */
export const FLOATS_PER_LANDMASS = 8;

/**
 * Create a land mass with default parameters.
 * Only control points are required.
 */
export function createLandMass(
  controlPoints: V2d[],
  overrides: Partial<Omit<LandMass, "controlPoints">> = {},
): LandMass {
  return {
    controlPoints,
    peakHeight: overrides.peakHeight ?? DEFAULT_PEAK_HEIGHT,
    beachWidth: overrides.beachWidth ?? DEFAULT_BEACH_WIDTH,
    hillFrequency: overrides.hillFrequency ?? DEFAULT_HILL_FREQUENCY,
    hillAmplitude: overrides.hillAmplitude ?? DEFAULT_HILL_AMPLITUDE,
  };
}

/**
 * Build GPU data arrays from terrain definition.
 * Returns flat arrays ready for upload to GPU buffers.
 *
 * IMPORTANT: The WGSL struct has u32 fields for startIndex and pointCount,
 * so we need to use a DataView to write integers with correct bit patterns.
 */
export function buildTerrainGPUData(definition: TerrainDefinition): {
  controlPointsData: Float32Array;
  landMassData: ArrayBuffer;
} {
  // Count total control points
  let totalPoints = 0;
  for (const lm of definition.landMasses) {
    totalPoints += lm.controlPoints.length;
  }

  const controlPointsData = new Float32Array(totalPoints * 2);

  // Use ArrayBuffer + DataView to write mixed u32/f32 data correctly
  const landMassBuffer = new ArrayBuffer(
    definition.landMasses.length * FLOATS_PER_LANDMASS * 4,
  );
  const landMassView = new DataView(landMassBuffer);

  let pointIndex = 0;
  for (let i = 0; i < definition.landMasses.length; i++) {
    const lm = definition.landMasses[i];

    // Store land mass metadata - byte offset for each land mass
    const byteBase = i * FLOATS_PER_LANDMASS * 4;

    // u32 fields (must use setUint32, not float)
    landMassView.setUint32(byteBase + 0, pointIndex, true); // startIndex
    landMassView.setUint32(byteBase + 4, lm.controlPoints.length, true); // pointCount

    // f32 fields
    landMassView.setFloat32(byteBase + 8, lm.peakHeight, true);
    landMassView.setFloat32(byteBase + 12, lm.beachWidth, true);
    landMassView.setFloat32(byteBase + 16, lm.hillFrequency, true);
    landMassView.setFloat32(byteBase + 20, lm.hillAmplitude, true);
    // byteBase + 24 and + 28 are padding (left as 0)

    // Store control points
    for (const pt of lm.controlPoints) {
      controlPointsData[pointIndex * 2 + 0] = pt.x;
      controlPointsData[pointIndex * 2 + 1] = pt.y;
      pointIndex++;
    }
  }

  return { controlPointsData, landMassData: landMassBuffer };
}
