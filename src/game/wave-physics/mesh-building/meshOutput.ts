import type { WavefrontMeshData } from "./MeshBuildTypes";
import type { Wavefront, WaveBounds, WavePoint } from "./marchingTypes";
import { VERTEX_FLOATS } from "./marchingTypes";

/**
 * Convert wavefront steps (each containing one or more disconnected segments)
 * into triangulated mesh data. Only segments with overlapping t-ranges between
 * adjacent steps are connected by triangles.
 */
export function buildMeshData(
  wavefronts: Wavefront[],
  wavelength: number,
  waveDx: number,
  waveDy: number,
  bounds: WaveBounds,
  stepIndices?: number[],
): WavefrontMeshData {
  const vertices: number[] = [];
  const indices: number[] = [];
  const segmentOffsets: number[][] = [];
  const k = (2 * Math.PI) / wavelength;

  for (let wi = 0; wi < wavefronts.length; wi++) {
    const step = wavefronts[wi];
    const stepOffsets: number[] = [];
    const phase = (stepIndices ? stepIndices[wi] : wi) * Math.PI;
    for (const segment of step) {
      stepOffsets.push(vertices.length / VERTEX_FLOATS);
      for (const p of segment) {
        const phaseOffset = phase - k * (p.x * waveDx + p.y * waveDy);
        vertices.push(p.x, p.y, p.amplitude, 0, phaseOffset, 1.0);
      }
    }
    segmentOffsets.push(stepOffsets);
  }

  for (let wi = 0; wi < wavefronts.length - 1; wi++) {
    triangulateBetweenSteps(
      wavefronts[wi],
      wavefronts[wi + 1],
      segmentOffsets[wi],
      segmentOffsets[wi + 1],
      indices,
    );
  }

  // Compute 4 corners of the wave-aligned oriented bounding box in world space
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const toWorld = (proj: number, perp: number): [number, number] => [
    proj * waveDx + perp * perpDx,
    proj * waveDy + perp * perpDy,
  ];
  const [x0, y0] = toWorld(bounds.minProj, bounds.minPerp);
  const [x1, y1] = toWorld(bounds.maxProj, bounds.minPerp);
  const [x2, y2] = toWorld(bounds.maxProj, bounds.maxPerp);
  const [x3, y3] = toWorld(bounds.minProj, bounds.maxPerp);

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    vertexCount: vertices.length / VERTEX_FLOATS,
    indexCount: indices.length,
    coverageQuad: { x0, y0, x1, y1, x2, y2, x3, y3 },
  };
}

/**
 * Match segments between two adjacent wavefront steps by t-range overlap
 * and triangulate each matching pair.
 */
function triangulateBetweenSteps(
  prevStep: Wavefront,
  nextStep: Wavefront,
  prevOffsets: number[],
  nextOffsets: number[],
  indices: number[],
): void {
  for (let pi = 0; pi < prevStep.length; pi++) {
    const prevSeg = prevStep[pi];
    if (prevSeg.length === 0) continue;
    const prevMinT = prevSeg[0].t;
    const prevMaxT = prevSeg[prevSeg.length - 1].t;

    for (let ni = 0; ni < nextStep.length; ni++) {
      const nextSeg = nextStep[ni];
      if (nextSeg.length === 0) continue;
      const nextMinT = nextSeg[0].t;
      const nextMaxT = nextSeg[nextSeg.length - 1].t;

      if (nextMinT > prevMaxT || nextMaxT < prevMinT) continue;

      const overlapMin = Math.max(prevMinT, nextMinT);
      const overlapMax = Math.min(prevMaxT, nextMaxT);
      const [pStart, pEnd] = clipToRange(prevSeg, overlapMin, overlapMax);
      const [nStart, nEnd] = clipToRange(nextSeg, overlapMin, overlapMax);

      if (pEnd < pStart || nEnd < nStart) continue;

      triangulateClipped(
        prevSeg,
        nextSeg,
        prevOffsets[pi],
        nextOffsets[ni],
        pStart,
        pEnd,
        nStart,
        nEnd,
        indices,
      );
    }
  }
}

/**
 * Find the index range within a segment whose t-values fall in [minT, maxT],
 * plus one point of padding on each side for edge triangle coverage.
 */
function clipToRange(
  seg: WavePoint[],
  minT: number,
  maxT: number,
): [number, number] {
  let start = 0;
  while (start < seg.length && seg[start].t < minT) start++;
  let end = seg.length - 1;
  while (end >= 0 && seg[end].t > maxT) end--;
  if (start > end) return [start, end];
  if (start > 0) start--;
  if (end < seg.length - 1) end++;
  return [start, end];
}

/**
 * Triangulate between clipped ranges of two segments, sweeping over
 * parametric t values. Handles segments with different vertex counts.
 */
function triangulateClipped(
  prevWF: WavePoint[],
  nextWF: WavePoint[],
  prevBase: number,
  nextBase: number,
  pStart: number,
  pEnd: number,
  nStart: number,
  nEnd: number,
  indices: number[],
): void {
  let i = pStart;
  let j = nStart;
  while (i < pEnd || j < nEnd) {
    if (i >= pEnd) {
      indices.push(prevBase + i, nextBase + j, nextBase + j + 1);
      j++;
    } else if (j >= nEnd) {
      indices.push(prevBase + i, prevBase + i + 1, nextBase + j);
      i++;
    } else if (prevWF[i + 1].t < nextWF[j + 1].t) {
      indices.push(prevBase + i, prevBase + i + 1, nextBase + j);
      i++;
    } else {
      indices.push(prevBase + i, nextBase + j, nextBase + j + 1);
      j++;
    }
  }
}
