/**
 * Test builder for pipeline validation.
 *
 * Produces a coarse grid covering the coastline bounds with default values
 * (amplitude=1, dirOffset=0, phaseOffset=0). No terrain evaluation.
 *
 * Purpose: verify the full pipeline works end-to-end:
 * worker -> mesh data -> GPU upload -> debug visualization
 */

import type { MeshBuildBounds, WavefrontMeshData } from "../MeshBuildTypes";
import type { WaveSource } from "../../../world/water/WaveSource";

/** Number of floats per mesh vertex */
const VERTEX_FLOATS = 5;

/** Grid spacing in feet */
const GRID_SPACING = 10;

/**
 * Build a test grid mesh covering the given bounds.
 */
export function buildTestMesh(
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
): WavefrontMeshData {
  const wavelength = waveSource.wavelength;

  // Determine bounds
  let minX: number, maxX: number, minY: number, maxY: number;
  if (coastlineBounds) {
    const margin = wavelength * 3;
    minX = coastlineBounds.minX - margin;
    maxX = coastlineBounds.maxX + margin;
    minY = coastlineBounds.minY - margin;
    maxY = coastlineBounds.maxY + margin;
  } else {
    minX = -500;
    maxX = 500;
    minY = -500;
    maxY = 500;
  }

  const cols = Math.max(2, Math.ceil((maxX - minX) / GRID_SPACING) + 1);
  const rows = Math.max(2, Math.ceil((maxY - minY) / GRID_SPACING) + 1);

  const vertexCount = cols * rows;
  const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);

  // Fill vertex data
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const vi = row * cols + col;
      const base = vi * VERTEX_FLOATS;
      vertices[base + 0] = minX + col * GRID_SPACING; // positionX
      vertices[base + 1] = minY + row * GRID_SPACING; // positionY
      vertices[base + 2] = 1.0; // amplitudeFactor
      vertices[base + 3] = 0.0; // directionOffset
      vertices[base + 4] = 0.0; // phaseOffset
    }
  }

  // Build triangle indices
  const quadsPerRow = cols - 1;
  const rowPairs = rows - 1;
  const indexCount = rowPairs * quadsPerRow * 6;
  const indices = new Uint32Array(indexCount);
  let idx = 0;

  for (let row = 0; row < rowPairs; row++) {
    for (let col = 0; col < quadsPerRow; col++) {
      const tl = row * cols + col;
      const tr = tl + 1;
      const bl = (row + 1) * cols + col;
      const br = bl + 1;

      // Triangle 1: tl, bl, tr
      indices[idx++] = tl;
      indices[idx++] = bl;
      indices[idx++] = tr;

      // Triangle 2: tr, bl, br
      indices[idx++] = tr;
      indices[idx++] = bl;
      indices[idx++] = br;
    }
  }

  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
  };
}
