/**
 * Contour tessellation utilities.
 *
 * Provides functions for tessellating Catmull-Rom spline contours into
 * triangle meshes for GPU rendering. Used by both the visual terrain
 * renderer and the physics tile compute pipeline.
 */

import { earClipTriangulate, Point2D } from "../../../core/util/Triangulate";
import { SPLINE_SUBDIVISIONS } from "./TerrainConstants";

/**
 * Result of tessellating a contour.
 */
export interface TessellatedContour {
  /** Vertex data: [x, y, contourIndex] per vertex, packed as floats */
  vertices: Float32Array;
  /** Triangle indices into vertex array */
  indices: Uint32Array;
  /** Number of vertices */
  vertexCount: number;
  /** Number of indices (triangleCount * 3) */
  indexCount: number;
}

/**
 * Tessellate a closed Catmull-Rom spline into triangles using ear clipping.
 *
 * @param controlPoints - Flat array of control point coordinates [x0, y0, x1, y1, ...]
 * @param pointStart - Starting index into controlPoints array (in points, not floats)
 * @param pointCount - Number of control points for this contour
 * @param contourIndex - Index to embed in vertex data for GPU identification
 * @returns Tessellated contour with vertices and triangle indices
 */
export function tessellateContour(
  controlPoints: Float32Array,
  pointStart: number,
  pointCount: number,
  contourIndex: number,
): TessellatedContour {
  // Sample the Catmull-Rom spline into a polygon
  const sampledPoints: Point2D[] = [];

  for (let i = 0; i < pointCount; i++) {
    const i0 = (i - 1 + pointCount) % pointCount;
    const i1 = i;
    const i2 = (i + 1) % pointCount;
    const i3 = (i + 2) % pointCount;

    const p0x = controlPoints[(pointStart + i0) * 2];
    const p0y = controlPoints[(pointStart + i0) * 2 + 1];
    const p1x = controlPoints[(pointStart + i1) * 2];
    const p1y = controlPoints[(pointStart + i1) * 2 + 1];
    const p2x = controlPoints[(pointStart + i2) * 2];
    const p2y = controlPoints[(pointStart + i2) * 2 + 1];
    const p3x = controlPoints[(pointStart + i3) * 2];
    const p3y = controlPoints[(pointStart + i3) * 2 + 1];

    // Sample this spline segment
    for (let j = 0; j < SPLINE_SUBDIVISIONS; j++) {
      const t = j / SPLINE_SUBDIVISIONS;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom spline formula
      const x =
        0.5 *
        (2 * p1x +
          (-p0x + p2x) * t +
          (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 +
          (-p0x + 3 * p1x - 3 * p2x + p3x) * t3);

      const y =
        0.5 *
        (2 * p1y +
          (-p0y + p2y) * t +
          (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
          (-p0y + 3 * p1y - 3 * p2y + p3y) * t3);

      sampledPoints.push({ x, y });
    }
  }

  const numSamples = sampledPoints.length;
  const emptyResult: TessellatedContour = {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    vertexCount: 0,
    indexCount: 0,
  };

  if (numSamples < 3) {
    return emptyResult;
  }

  // Triangulate the polygon
  const triangleIndices = earClipTriangulate(sampledPoints);

  // Triangulation failed - skip this contour
  if (!triangleIndices) {
    return emptyResult;
  }

  // Build vertex buffer: [x, y, contourIndex] per vertex
  // contourIndex is stored as a uint32 bit pattern in a float32 slot
  const vertexCount = numSamples;
  const vertices = new Float32Array(vertexCount * 3);
  const indexView = new DataView(vertices.buffer);

  for (let i = 0; i < numSamples; i++) {
    const offset = i * 3;
    vertices[offset] = sampledPoints[i].x;
    vertices[offset + 1] = sampledPoints[i].y;
    // Write contourIndex as uint32 into the float32 slot
    indexView.setUint32((offset + 2) * 4, contourIndex, true);
  }

  return {
    vertices,
    indices: new Uint32Array(triangleIndices),
    vertexCount,
    indexCount: triangleIndices.length,
  };
}
