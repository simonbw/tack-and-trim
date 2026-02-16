import type { Wavefront, WaveBounds, WavefrontSegment } from "./marchingTypes";
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
) {
  const topology = countMeshTopology(wavefronts);
  const vertices = new Float32Array(topology.vertexCount * VERTEX_FLOATS);
  const indices = new Uint32Array(topology.triangleCount * 3);
  const k = (2 * Math.PI) / wavelength;
  const resolvedPhasePerStep = phasePerStep ?? Math.PI;
  let vertexOffset = 0;
  let indexOffset = 0;
  let prevStep: Wavefront | null = null;
  let prevStepOffsets: number[] | null = null;

  for (let wi = 0; wi < wavefronts.length; wi++) {
    const step = wavefronts[wi];
    const stepOffsets: number[] = [];
    const phase = (stepIndices ? stepIndices[wi] : wi) * resolvedPhasePerStep;
    const isBoundaryStep = wi === 0 || wi === wavefronts.length - 1;

    for (const segment of step) {
      const segX = segment.x;
      const segY = segment.y;
      const segAmp = segment.amplitude;
      const segBroken = segment.broken;
      const len = segX.length;

      stepOffsets.push(vertexOffset / VERTEX_FLOATS);
      for (let pi = 0; pi < len; pi++) {
        const x = segX[pi];
        const y = segY[pi];
        const phaseOffset = phase - k * (x * waveDx + y * waveDy);
        const isBoundary = isBoundaryStep || pi === 0 || pi === len - 1;

        vertices[vertexOffset++] = x;
        vertices[vertexOffset++] = y;
        vertices[vertexOffset++] = segAmp[pi];
        vertices[vertexOffset++] = segBroken[pi];
        vertices[vertexOffset++] = phaseOffset;
        vertices[vertexOffset++] = isBoundary ? 0.0 : 1.0;
      }
    }

    if (prevStep && prevStepOffsets) {
      indexOffset = triangulateBetweenSteps(
        prevStep,
        step,
        prevStepOffsets,
        stepOffsets,
        indices,
        indexOffset,
      );
    }

    prevStep = step;
    prevStepOffsets = stepOffsets;
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
  const finalVertexCount = vertexOffset / VERTEX_FLOATS;
  const finalIndices =
    indexOffset === indices.length ? indices : indices.subarray(0, indexOffset);

  return {
    vertices,
    indices: finalIndices,
    vertexCount: finalVertexCount,
    indexCount: indexOffset,
    coverageQuad: { x0, y0, x1, y1, x2, y2, x3, y3 },
  };
}

/**
 * Count mesh topology for a set of wavefronts without allocating vertex/index buffers.
 */
export function countMeshTopology(wavefronts: Wavefront[]): {
  vertexCount: number;
  triangleCount: number;
} {
  let vertexCount = 0;
  for (const step of wavefronts) {
    for (const segment of step) {
      vertexCount += segment.t.length;
    }
  }

  let triangleCount = 0;
  for (let wi = 0; wi < wavefronts.length - 1; wi++) {
    triangleCount += countTrianglesBetweenSteps(
      wavefronts[wi],
      wavefronts[wi + 1],
    );
  }

  return { vertexCount, triangleCount };
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
  indices: Uint32Array,
  indexOffset: number,
): number {
  for (let pi = 0; pi < prevStep.length; pi++) {
    const prevSeg = prevStep[pi];
    const prevT = prevSeg.t;
    const prevLen = prevT.length;
    if (prevLen === 0) continue;

    const prevMinT = prevT[0];
    const prevMaxT = prevT[prevLen - 1];

    for (let ni = 0; ni < nextStep.length; ni++) {
      const nextSeg = nextStep[ni];
      const nextT = nextSeg.t;
      const nextLen = nextT.length;
      if (nextLen === 0) continue;

      const nextMinT = nextT[0];
      const nextMaxT = nextT[nextLen - 1];

      if (nextMinT > prevMaxT || nextMaxT < prevMinT) continue;

      const overlapMin = Math.max(prevMinT, nextMinT);
      const overlapMax = Math.min(prevMaxT, nextMaxT);
      const [pStart, pEnd] = clipToRange(prevSeg, overlapMin, overlapMax);
      const [nStart, nEnd] = clipToRange(nextSeg, overlapMin, overlapMax);

      if (pEnd < pStart || nEnd < nStart) continue;

      indexOffset = triangulateClipped(
        prevSeg,
        nextSeg,
        prevOffsets[pi],
        nextOffsets[ni],
        pStart,
        pEnd,
        nStart,
        nEnd,
        indices,
        indexOffset,
      );
    }
  }

  return indexOffset;
}

function countTrianglesBetweenSteps(
  prevStep: Wavefront,
  nextStep: Wavefront,
): number {
  let triangles = 0;

  for (let pi = 0; pi < prevStep.length; pi++) {
    const prevSeg = prevStep[pi];
    const prevT = prevSeg.t;
    const prevLen = prevT.length;
    if (prevLen === 0) continue;

    const prevMinT = prevT[0];
    const prevMaxT = prevT[prevLen - 1];

    for (let ni = 0; ni < nextStep.length; ni++) {
      const nextSeg = nextStep[ni];
      const nextT = nextSeg.t;
      const nextLen = nextT.length;
      if (nextLen === 0) continue;

      const nextMinT = nextT[0];
      const nextMaxT = nextT[nextLen - 1];

      if (nextMinT > prevMaxT || nextMaxT < prevMinT) continue;

      const overlapMin = Math.max(prevMinT, nextMinT);
      const overlapMax = Math.min(prevMaxT, nextMaxT);
      const [pStart, pEnd] = clipToRange(prevSeg, overlapMin, overlapMax);
      const [nStart, nEnd] = clipToRange(nextSeg, overlapMin, overlapMax);

      if (pEnd < pStart || nEnd < nStart) continue;

      // Each loop step emits exactly one triangle while advancing one side.
      triangles += pEnd - pStart + (nEnd - nStart);
    }
  }

  return triangles;
}

/**
 * Find the index range within a segment whose t-values fall in [minT, maxT],
 * plus one point of padding on each side for edge triangle coverage.
 */
function clipToRange(
  seg: WavefrontSegment,
  minT: number,
  maxT: number,
): [number, number] {
  const t = seg.t;
  const len = t.length;

  let start = 0;
  while (start < len && t[start] < minT) start++;
  let end = len - 1;
  while (end >= 0 && t[end] > maxT) end--;
  if (start > end) return [start, end];
  if (start > 0) start--;
  if (end < len - 1) end++;
  return [start, end];
}

/**
 * Score a triangle based on geometric quality. Lower score = better quality.
 * Uses sum of squared edge lengths to prefer compact triangles.
 */
function scoreTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const dx1 = bx - ax;
  const dy1 = by - ay;
  const dx2 = cx - bx;
  const dy2 = cy - by;
  const dx3 = ax - cx;
  const dy3 = ay - cy;
  return dx1 * dx1 + dy1 * dy1 + dx2 * dx2 + dy2 * dy2 + dx3 * dx3 + dy3 * dy3;
}

/**
 * Triangulate between clipped ranges of two segments, sweeping over
 * parametric t values. Handles segments with different vertex counts.
 * Uses geometric quality scoring to avoid skinny triangles.
 */
function triangulateClipped(
  prevWF: WavefrontSegment,
  nextWF: WavefrontSegment,
  prevBase: number,
  nextBase: number,
  pStart: number,
  pEnd: number,
  nStart: number,
  nEnd: number,
  indices: Uint32Array,
  indexOffset: number,
): number {
  const prevX = prevWF.x;
  const prevY = prevWF.y;
  const nextX = nextWF.x;
  const nextY = nextWF.y;

  let i = pStart;
  let j = nStart;
  while (i < pEnd || j < nEnd) {
    if (i >= pEnd) {
      // Only next row has vertices left
      indices[indexOffset++] = prevBase + i;
      indices[indexOffset++] = nextBase + j;
      indices[indexOffset++] = nextBase + j + 1;
      j++;
    } else if (j >= nEnd) {
      // Only prev row has vertices left
      indices[indexOffset++] = prevBase + i;
      indices[indexOffset++] = prevBase + i + 1;
      indices[indexOffset++] = nextBase + j;
      i++;
    } else {
      // Both rows have vertices - choose based on triangle quality
      const currX = prevX[i];
      const currY = prevY[i];

      // Option A: advance i (use next vertex from prev row)
      const scoreA = scoreTriangle(
        currX,
        currY,
        prevX[i + 1],
        prevY[i + 1],
        nextX[j],
        nextY[j],
      );

      // Option B: advance j (use next vertex from next row)
      const scoreB = scoreTriangle(
        currX,
        currY,
        nextX[j],
        nextY[j],
        nextX[j + 1],
        nextY[j + 1],
      );

      if (scoreA < scoreB) {
        indices[indexOffset++] = prevBase + i;
        indices[indexOffset++] = prevBase + i + 1;
        indices[indexOffset++] = nextBase + j;
        i++;
      } else {
        indices[indexOffset++] = prevBase + i;
        indices[indexOffset++] = nextBase + j;
        indices[indexOffset++] = nextBase + j + 1;
        j++;
      }
    }
  }

  return indexOffset;
}
