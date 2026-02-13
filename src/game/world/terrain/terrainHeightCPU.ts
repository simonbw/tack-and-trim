/**
 * CPU port of terrain height computation (terrain.wgsl.ts).
 *
 * Pure TypeScript implementation of the GPU terrain height shader, for use
 * in web workers and tests where GPU shaders are unavailable. Ported 1:1 from:
 * - polygon.wgsl.ts: pointLeftOfSegment, pointToLineSegmentDistanceSq
 * - terrain-packed.wgsl.ts: ContourData accessors
 * - terrain.wgsl.ts: isInsideContour, computeDistanceToBoundary, computeTerrainHeight
 *
 * No engine imports — safe for use in web workers.
 */

import type { TerrainCPUData } from "./TerrainCPUData";

/** Number of 32-bit values per contour (must match LandMass.FLOATS_PER_CONTOUR) */
const FLOATS_PER_CONTOUR = 13;

/** Minimum distance for IDW to avoid division by zero */
const IDW_MIN_DIST = 0.1;

// =============================================================================
// Pre-parsed contour data cache
// =============================================================================

/**
 * Pre-parsed contour data. Parsed once from the packed ArrayBuffer
 * to avoid creating DataView and objects on every access.
 */
interface ParsedContour {
  pointStartIndex: number;
  pointCount: number;
  height: number;
  depth: number;
  childStartIndex: number;
  childCount: number;
  skipCount: number;
  bboxMinX: number;
  bboxMinY: number;
  bboxMaxX: number;
  bboxMaxY: number;
}

/** Cache pre-parsed contour data keyed by the underlying ArrayBuffer */
const parsedContourCache = new WeakMap<ArrayBuffer, ParsedContour[]>();

/**
 * Get or create pre-parsed contour data for the given terrain.
 * Parses the packed contourData ArrayBuffer once, then reuses on subsequent calls.
 */
function getParsedContours(terrain: TerrainCPUData): ParsedContour[] {
  let parsed = parsedContourCache.get(terrain.contourData);
  if (parsed) return parsed;

  const view = new DataView(terrain.contourData);
  const count = terrain.contourCount;
  parsed = new Array(count);

  for (let i = 0; i < count; i++) {
    const byteBase = i * FLOATS_PER_CONTOUR * 4;
    parsed[i] = {
      pointStartIndex: view.getUint32(byteBase + 0, true),
      pointCount: view.getUint32(byteBase + 4, true),
      height: view.getFloat32(byteBase + 8, true),
      depth: view.getUint32(byteBase + 16, true),
      childStartIndex: view.getUint32(byteBase + 20, true),
      childCount: view.getUint32(byteBase + 24, true),
      skipCount: view.getUint32(byteBase + 48, true),
      bboxMinX: view.getFloat32(byteBase + 32, true),
      bboxMinY: view.getFloat32(byteBase + 36, true),
      bboxMaxX: view.getFloat32(byteBase + 40, true),
      bboxMaxY: view.getFloat32(byteBase + 44, true),
    };
  }

  parsedContourCache.set(terrain.contourData, parsed);
  return parsed;
}

// =============================================================================
// Polygon utility functions (from polygon.wgsl.ts)
// =============================================================================

/**
 * Test if point p is left of line segment [a, b].
 * Returns positive if left, negative if right, zero if collinear.
 * (Cross product of (b - a) and (p - a))
 */
export function pointLeftOfSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (bx - ax) * (py - ay) - (px - ax) * (by - ay);
}

/**
 * Compute squared distance from point p to line segment [a, b].
 */
export function pointToLineSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;

  if (lengthSq === 0) {
    const dx = px - ax;
    const dy = py - ay;
    return dx * dx + dy * dy;
  }

  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSq),
  );
  const nearestX = ax + t * abx;
  const nearestY = ay + t * aby;
  const dx = px - nearestX;
  const dy = py - nearestY;
  return dx * dx + dy * dy;
}

// =============================================================================
// Terrain height core functions (from terrain.wgsl.ts)
// =============================================================================

/**
 * Fast containment test using winding number algorithm.
 * Reads vertex data directly from Float32Array to avoid tuple allocation.
 * Includes early bbox check. Returns true if point is inside the contour.
 */
export function isInsideContour(
  x: number,
  y: number,
  contourIndex: number,
  terrain: TerrainCPUData,
): boolean {
  const contours = getParsedContours(terrain);
  return isInsideContourFast(x, y, contours[contourIndex], terrain.vertexData);
}

/**
 * Internal fast containment test using pre-parsed contour data.
 * Zero allocation — reads vertices directly from the Float32Array.
 */
function isInsideContourFast(
  x: number,
  y: number,
  c: ParsedContour,
  vertexData: Float32Array,
): boolean {
  // Early bbox check
  if (x < c.bboxMinX || x > c.bboxMaxX || y < c.bboxMinY || y > c.bboxMaxY) {
    return false;
  }

  const n = c.pointCount;
  const start = c.pointStartIndex;
  let windingNumber = 0;

  // Use sliding window to avoid modulo and read each vertex only once
  // Start with the last vertex
  let prevBase = (start + n - 1) * 2;
  let ay = vertexData[prevBase + 1];

  for (let i = 0; i < n; i++) {
    const curBase = (start + i) * 2;
    const by = vertexData[curBase + 1];

    // Only compute the full cross product when the edge crosses y
    if (ay <= y) {
      if (by > y) {
        const ax = vertexData[prevBase];
        const bx = vertexData[curBase];
        if ((bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) {
          windingNumber++;
        }
      }
    } else {
      if (by <= y) {
        const ax = vertexData[prevBase];
        const bx = vertexData[curBase];
        if ((bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) {
          windingNumber--;
        }
      }
    }

    prevBase = curBase;
    ay = by;
  }

  return windingNumber !== 0;
}

/**
 * Compute minimum distance to contour boundary.
 * Zero allocation — reads vertices directly from the Float32Array.
 */
export function computeDistanceToBoundary(
  x: number,
  y: number,
  contourIndex: number,
  terrain: TerrainCPUData,
): number {
  const contours = getParsedContours(terrain);
  return computeDistanceToBoundaryFast(
    x,
    y,
    contours[contourIndex],
    terrain.vertexData,
  );
}

/**
 * Internal fast distance computation using pre-parsed contour data.
 */
function computeDistanceToBoundaryFast(
  x: number,
  y: number,
  c: ParsedContour,
  vertexData: Float32Array,
): number {
  const n = c.pointCount;
  const start = c.pointStartIndex;
  let minDistSq = 1e20;

  // Sliding window: avoid reading each vertex twice
  let prevBase = (start + n - 1) * 2;
  let ax = vertexData[prevBase];
  let ay = vertexData[prevBase + 1];

  for (let i = 0; i < n; i++) {
    const curBase = (start + i) * 2;
    const bx = vertexData[curBase];
    const by = vertexData[curBase + 1];

    // Inline pointToLineSegmentDistanceSq
    const abx = bx - ax;
    const aby = by - ay;
    const lengthSq = abx * abx + aby * aby;

    let distSq: number;
    if (lengthSq === 0) {
      const dx = x - ax;
      const dy = y - ay;
      distSq = dx * dx + dy * dy;
    } else {
      let t = ((x - ax) * abx + (y - ay) * aby) / lengthSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const nearestX = ax + t * abx;
      const nearestY = ay + t * aby;
      const dx = x - nearestX;
      const dy = y - nearestY;
      distSq = dx * dx + dy * dy;
    }

    if (distSq < minDistSq) {
      minDistSq = distSq;
    }

    ax = bx;
    ay = by;
  }

  return Math.sqrt(minDistSq);
}

/**
 * Compute terrain height at a world point using IDW interpolation.
 *
 * Algorithm:
 * 1. Find the deepest contour containing the point using DFS skip traversal
 * 2. If no contour contains the point, return defaultDepth
 * 3. If the deepest contour has no children, return its height directly
 * 4. Otherwise, IDW blend between parent and children using boundary distances
 */
export function computeTerrainHeight(
  x: number,
  y: number,
  terrain: TerrainCPUData,
): number {
  const contourCount = terrain.contourCount;
  const defaultDepth = terrain.defaultDepth;
  const contours = getParsedContours(terrain);
  const vertexData = terrain.vertexData;

  // Phase 1: Find the deepest containing contour using DFS skip traversal
  let deepestIndex = -1;
  let deepestDepth = 0;
  let i = 0;
  let lastToCheck = contourCount;

  while (i < lastToCheck) {
    const contour = contours[i];

    if (isInsideContourFast(x, y, contour, vertexData)) {
      if (contour.depth >= deepestDepth) {
        deepestDepth = contour.depth;
        deepestIndex = i;
      }
      // Narrow search to only this contour's descendants
      lastToCheck = i + contour.skipCount + 1;
      i += 1;
    } else {
      // Skip entire subtree
      i += contour.skipCount + 1;
    }
  }

  // Phase 2: If not inside any contour, return default depth
  if (deepestIndex < 0) {
    return defaultDepth;
  }

  const parent = contours[deepestIndex];

  // Phase 3: If the parent has no children, return its height directly
  if (parent.childCount === 0) {
    return parent.height;
  }

  // Phase 4: IDW interpolation between parent and children
  const distToParent = computeDistanceToBoundaryFast(x, y, parent, vertexData);
  const parentWeight = 1 / Math.max(distToParent, IDW_MIN_DIST);
  let totalWeight = parentWeight;
  let weightedSum = parent.height * parentWeight;

  for (let c = 0; c < parent.childCount; c++) {
    const childIndex = terrain.childrenData[parent.childStartIndex + c];
    const child = contours[childIndex];
    const distToChild = computeDistanceToBoundaryFast(x, y, child, vertexData);
    const childWeight = 1 / Math.max(distToChild, IDW_MIN_DIST);
    totalWeight += childWeight;
    weightedSum += child.height * childWeight;
  }

  return weightedSum / totalWeight;
}
