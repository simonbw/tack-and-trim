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
  controlPoints: V2d[];

  /** Max height above water (ft), e.g., 3-8 ft for sandy islands */
  peakHeight: number;

  /** Distance from shore where terrain starts rising (ft), e.g., 15-30 ft */
  beachWidth: number;

  /** Noise spatial scale for rolling hills */
  hillFrequency: number;

  /** Height variation as fraction of peakHeight */
  hillAmplitude: number;
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
  overrides: Partial<Omit<LandMass, "controlPoints">> = {}
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
 */
export function buildTerrainGPUData(definition: TerrainDefinition): {
  controlPointsData: Float32Array;
  landMassData: Float32Array;
} {
  // Count total control points
  let totalPoints = 0;
  for (const lm of definition.landMasses) {
    totalPoints += lm.controlPoints.length;
  }

  const controlPointsData = new Float32Array(totalPoints * 2);
  const landMassData = new Float32Array(
    definition.landMasses.length * FLOATS_PER_LANDMASS
  );

  let pointIndex = 0;
  for (let i = 0; i < definition.landMasses.length; i++) {
    const lm = definition.landMasses[i];

    // Store land mass metadata
    const base = i * FLOATS_PER_LANDMASS;
    landMassData[base + 0] = pointIndex;
    landMassData[base + 1] = lm.controlPoints.length;
    landMassData[base + 2] = lm.peakHeight;
    landMassData[base + 3] = lm.beachWidth;
    landMassData[base + 4] = lm.hillFrequency;
    landMassData[base + 5] = lm.hillAmplitude;
    // [6], [7] = padding for alignment

    // Store control points
    for (const pt of lm.controlPoints) {
      controlPointsData[pointIndex * 2 + 0] = pt.x;
      controlPointsData[pointIndex * 2 + 1] = pt.y;
      pointIndex++;
    }
  }

  return { controlPointsData, landMassData };
}
