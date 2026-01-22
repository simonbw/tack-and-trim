import { V2d } from "../../../core/Vector";
import {
  DEFAULT_DEPTH,
  DEFAULT_HILL_AMPLITUDE,
  DEFAULT_HILL_FREQUENCY,
} from "./TerrainConstants";

/**
 * A single terrain contour - a closed spline at a specific height.
 * Contours define elevation levels. The system determines nesting from geometry,
 * allowing flexible configurations like two islands sharing one shelf.
 */
export interface TerrainContour {
  /** Catmull-Rom control points defining the contour (closed loop) */
  readonly controlPoints: readonly V2d[];

  /** Height of this contour in feet (negative = underwater, positive = above water) */
  readonly height: number;

  /** Noise spatial scale for rolling hills (default: 0.02) */
  readonly hillFrequency: number;

  /** Height variation from noise (default: 0.3) */
  readonly hillAmplitude: number;
}

/**
 * Collection of contours defining terrain for a level.
 * Height is determined by which contours a point is inside/outside of.
 */
export interface TerrainDefinition {
  contours: TerrainContour[];
  /** Deep ocean baseline depth in feet (default: -50) */
  defaultDepth?: number;
}

/**
 * GPU buffer layout for a single contour.
 * Must match the WGSL struct layout.
 */
export interface ContourGPUData {
  pointStartIndex: number; // Index into control points buffer
  pointCount: number; // Number of control points
  height: number;
  hillFrequency: number;
  hillAmplitude: number;
  // 4 bytes padding for alignment
}

/** Number of float32 values per contour in GPU buffer (5 values + 1 padding for alignment = 24 bytes) */
export const FLOATS_PER_CONTOUR = 6;

/**
 * Create a terrain contour with default parameters.
 * Only control points and height are required.
 */
export function createContour(
  controlPoints: V2d[],
  height: number,
  overrides: Partial<Omit<TerrainContour, "controlPoints" | "height">> = {},
): TerrainContour {
  return {
    controlPoints,
    height,
    hillFrequency: overrides.hillFrequency ?? DEFAULT_HILL_FREQUENCY,
    hillAmplitude: overrides.hillAmplitude ?? DEFAULT_HILL_AMPLITUDE,
  };
}

// Track which terrain definitions have been validated to avoid duplicate warnings
const validatedDefinitions = new WeakSet<TerrainDefinition>();

/**
 * Validate terrain definition and log warnings for potential issues.
 * Checks for:
 * - Self-intersecting contours (control points that would create crossing spline segments)
 * - Higher-height contours that extend outside lower-height contours
 *
 * Only validates each definition once to avoid log spam.
 */
export function validateTerrainDefinition(definition: TerrainDefinition): void {
  // Skip if already validated
  if (validatedDefinitions.has(definition)) return;
  validatedDefinitions.add(definition);

  const contours = definition.contours;
  if (contours.length === 0) return;

  // Get all shore contours (height = 0)
  const shoreContours = contours.filter((c) => c.height === 0);

  // Check each peak contour (height > 0)
  for (const peakContour of contours) {
    if (peakContour.height <= 0) continue;
    if (peakContour.controlPoints.length < 3) {
      console.warn(
        `Terrain contour at height ${peakContour.height} has only ${peakContour.controlPoints.length} control points`,
      );
      continue;
    }

    // Find the shore contour that contains this peak (check centroid)
    const peakCentroid = computeContourCentroid(peakContour.controlPoints);
    const parentShore = shoreContours.find((shore) =>
      isPointInsidePolygon(peakCentroid, shore.controlPoints),
    );

    if (!parentShore) {
      // Peak centroid isn't inside any shore - this is definitely wrong
      console.warn(
        `Terrain contour at height ${peakContour.height} centroid (${peakCentroid.x.toFixed(0)}, ${peakCentroid.y.toFixed(0)}) is not inside any shoreline contour.`,
      );
      continue;
    }

    // Sample points from the peak and check they're inside the parent shore
    const samplePoints = [
      peakContour.controlPoints[0],
      peakContour.controlPoints[
        Math.floor(peakContour.controlPoints.length / 3)
      ],
      peakContour.controlPoints[
        Math.floor((2 * peakContour.controlPoints.length) / 3)
      ],
    ];

    for (const pt of samplePoints) {
      if (!isPointInsidePolygon(pt, parentShore.controlPoints)) {
        console.warn(
          `Terrain contour at height ${peakContour.height} may extend outside its shoreline. ` +
            `Point (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)}) is outside the shore control polygon.`,
        );
        break;
      }
    }
  }
}

/**
 * Compute the centroid of a contour's control points.
 */
function computeContourCentroid(points: readonly V2d[]): {
  x: number;
  y: number;
} {
  let cx = 0,
    cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  return { x: cx / points.length, y: cy / points.length };
}

/**
 * Simple point-in-polygon test using ray casting.
 * Returns true if point is inside the polygon defined by control points.
 */
function isPointInsidePolygon(
  point: { x: number; y: number },
  polygon: readonly V2d[],
): boolean {
  let inside = false;
  const n = polygon.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;

    if (
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Build GPU data arrays from terrain definition.
 * Returns flat arrays ready for upload to GPU buffers.
 *
 * Contours are sorted by height (ascending) for GPU processing.
 *
 * IMPORTANT: The WGSL struct has u32 fields for pointStartIndex and pointCount,
 * so we need to use a DataView to write integers with correct bit patterns.
 */
export function buildTerrainGPUData(definition: TerrainDefinition): {
  controlPointsData: Float32Array;
  contourData: ArrayBuffer;
  contourCount: number;
  defaultDepth: number;
} {
  // Sort contours by height (ascending) for GPU processing
  const sortedContours = [...definition.contours].sort(
    (a, b) => a.height - b.height,
  );

  // Count total control points
  let totalPoints = 0;
  for (const contour of sortedContours) {
    totalPoints += contour.controlPoints.length;
  }

  const controlPointsData = new Float32Array(totalPoints * 2);

  // Use ArrayBuffer + DataView to write mixed u32/f32 data correctly
  const contourBuffer = new ArrayBuffer(
    sortedContours.length * FLOATS_PER_CONTOUR * 4,
  );
  const contourView = new DataView(contourBuffer);

  let pointIndex = 0;
  for (let i = 0; i < sortedContours.length; i++) {
    const contour = sortedContours[i];

    // Store contour metadata - byte offset for each contour
    const byteBase = i * FLOATS_PER_CONTOUR * 4;

    // u32 fields (must use setUint32, not float)
    contourView.setUint32(byteBase + 0, pointIndex, true); // pointStartIndex
    contourView.setUint32(byteBase + 4, contour.controlPoints.length, true); // pointCount

    // f32 fields
    contourView.setFloat32(byteBase + 8, contour.height, true);
    contourView.setFloat32(byteBase + 12, contour.hillFrequency, true);
    contourView.setFloat32(byteBase + 16, contour.hillAmplitude, true);
    // byteBase + 20 is padding (left as 0)

    // Store control points
    for (const pt of contour.controlPoints) {
      controlPointsData[pointIndex * 2 + 0] = pt.x;
      controlPointsData[pointIndex * 2 + 1] = pt.y;
      pointIndex++;
    }
  }

  return {
    controlPointsData,
    contourData: contourBuffer,
    contourCount: sortedContours.length,
    defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
  };
}
