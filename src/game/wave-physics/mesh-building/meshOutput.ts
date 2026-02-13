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
  phasePerStep?: number,
): WavefrontMeshData {
  const vertices: number[] = [];
  const indices: number[] = [];
  const segmentOffsets: number[][] = [];
  const k = (2 * Math.PI) / wavelength;
  const resolvedPhasePerStep = phasePerStep ?? Math.PI;

  for (let wi = 0; wi < wavefronts.length; wi++) {
    const step = wavefronts[wi];
    const stepOffsets: number[] = [];
    const phase = (stepIndices ? stepIndices[wi] : wi) * resolvedPhasePerStep;
    const isBoundaryStep = wi === 0 || wi === wavefronts.length - 1;
    for (const segment of step) {
      stepOffsets.push(vertices.length / VERTEX_FLOATS);
      for (let pi = 0; pi < segment.length; pi++) {
        const p = segment[pi];
        const phaseOffset = phase - k * (p.x * waveDx + p.y * waveDy);
        const isBoundary =
          isBoundaryStep || pi === 0 || pi === segment.length - 1;
        vertices.push(
          p.x,
          p.y,
          p.amplitude,
          p.broken,
          phaseOffset,
          isBoundary ? 0.0 : 1.0,
        );
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
 * Score a triangle based on geometric quality. Lower score = better quality.
 * Uses sum of squared edge lengths to prefer compact triangles.
 */
function scoreTriangle(a: WavePoint, b: WavePoint, c: WavePoint): number {
  const dx1 = b.x - a.x;
  const dy1 = b.y - a.y;
  const dx2 = c.x - b.x;
  const dy2 = c.y - b.y;
  const dx3 = a.x - c.x;
  const dy3 = a.y - c.y;
  return dx1 * dx1 + dy1 * dy1 + dx2 * dx2 + dy2 * dy2 + dx3 * dx3 + dy3 * dy3;
}

/**
 * Triangulate between clipped ranges of two segments, sweeping over
 * parametric t values. Handles segments with different vertex counts.
 * Uses geometric quality scoring to avoid skinny triangles.
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
      // Only next row has vertices left
      indices.push(prevBase + i, nextBase + j, nextBase + j + 1);
      j++;
    } else if (j >= nEnd) {
      // Only prev row has vertices left
      indices.push(prevBase + i, prevBase + i + 1, nextBase + j);
      i++;
    } else {
      // Both rows have vertices - choose based on triangle quality
      const curr = prevWF[i];
      const nextPrev = prevWF[i + 1];
      const nextNext = nextWF[j + 1];
      const currNext = nextWF[j];

      // Option A: advance i (use next vertex from prev row)
      const scoreA = scoreTriangle(curr, nextPrev, currNext);
      // Option B: advance j (use next vertex from next row)
      const scoreB = scoreTriangle(curr, currNext, nextNext);

      if (scoreA < scoreB) {
        // Option A is better quality
        indices.push(prevBase + i, prevBase + i + 1, nextBase + j);
        i++;
      } else {
        // Option B is better quality
        indices.push(prevBase + i, nextBase + j, nextBase + j + 1);
        j++;
      }
    }
  }
}
