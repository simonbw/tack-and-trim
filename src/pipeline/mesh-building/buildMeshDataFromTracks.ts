import type { WaveBounds, WavefrontSegment } from "./marchingTypes";
import { VERTEX_FLOATS } from "./marchingTypes";
import type { SegmentTrack } from "./buildSegmentTracks";
import { assertWavefrontInvariants } from "./wavefrontContracts";

export function buildMeshDataFromTracks(
  tracks: SegmentTrack[],
  wavelength: number,
  waveDx: number,
  waveDy: number,
  bounds: WaveBounds,
  phasePerStep: number,
) {
  const topology = countMeshTopologyFromTracks(tracks);
  const vertices = new Float32Array(topology.vertexCount * VERTEX_FLOATS);
  const indices = new Uint32Array(topology.triangleCount * 3);
  const k = (2 * Math.PI) / wavelength;

  const baseBySegment = new WeakMap<WavefrontSegment, number>();
  let vertexOffset = 0;
  let indexOffset = 0;

  const ensureSegmentVertices = (segment: WavefrontSegment): number => {
    const existingBase = baseBySegment.get(segment);
    if (existingBase !== undefined) {
      return existingBase;
    }

    const base = vertexOffset / VERTEX_FLOATS;
    baseBySegment.set(segment, base);

    const segX = segment.x;
    const segY = segment.y;
    const segAmp = segment.amplitude;
    const segTurbulence = segment.turbulence;
    const segBlend = segment.blend;
    const phaseBase = segment.sourceStepIndex * phasePerStep;
    for (let pi = 0; pi < segX.length; pi++) {
      const x = segX[pi];
      const y = segY[pi];
      const phaseOffset = phaseBase - k * (x * waveDx + y * waveDy);

      vertices[vertexOffset++] = x;
      vertices[vertexOffset++] = y;
      vertices[vertexOffset++] = segAmp[pi];
      vertices[vertexOffset++] = segTurbulence[pi];
      vertices[vertexOffset++] = phaseOffset;
      vertices[vertexOffset++] = segBlend[pi];
    }

    return base;
  };

  for (const track of tracks) {
    for (let si = 0; si < track.snapshots.length - 1; si++) {
      const prevSegment = track.snapshots[si].segment;
      const nextSegment = track.snapshots[si + 1].segment;
      assertWavefrontInvariants([prevSegment], "buildMeshDataFromTracks prev");
      assertWavefrontInvariants([nextSegment], "buildMeshDataFromTracks next");

      const prevBase = ensureSegmentVertices(prevSegment);
      const nextBase = ensureSegmentVertices(nextSegment);
      indexOffset = triangulateSegmentPair(
        prevSegment,
        nextSegment,
        prevBase,
        nextBase,
        indices,
        indexOffset,
      );
    }
  }

  const coverageQuad = computeCoverageQuad(bounds, waveDx, waveDy);
  const finalVertexCount = vertexOffset / VERTEX_FLOATS;
  const finalIndices =
    indexOffset === indices.length ? indices : indices.subarray(0, indexOffset);

  return {
    vertices,
    indices: finalIndices,
    vertexCount: finalVertexCount,
    indexCount: indexOffset,
    coverageQuad,
  };
}

export function countMeshTopologyFromTracks(tracks: SegmentTrack[]): {
  vertexCount: number;
  triangleCount: number;
} {
  const uniqueSegments = new Set<WavefrontSegment>();
  let triangleCount = 0;

  for (const track of tracks) {
    for (const snapshot of track.snapshots) {
      assertWavefrontInvariants([snapshot.segment], "countMeshTopologyFromTracks");
      uniqueSegments.add(snapshot.segment);
    }
    for (let si = 0; si < track.snapshots.length - 1; si++) {
      triangleCount += countTrianglesBetweenSegments(
        track.snapshots[si].segment,
        track.snapshots[si + 1].segment,
      );
    }
  }

  let vertexCount = 0;
  for (const segment of uniqueSegments) {
    vertexCount += segment.t.length;
  }

  return { vertexCount, triangleCount };
}

function triangulateSegmentPair(
  prevSeg: WavefrontSegment,
  nextSeg: WavefrontSegment,
  prevBase: number,
  nextBase: number,
  indices: Uint32Array,
  indexOffset: number,
): number {
  const prevT = prevSeg.t;
  const prevLen = prevT.length;
  if (prevLen === 0) return indexOffset;

  const nextT = nextSeg.t;
  const nextLen = nextT.length;
  if (nextLen === 0) return indexOffset;

  const prevMinT = prevT[0];
  const prevMaxT = prevT[prevLen - 1];
  const nextMinT = nextT[0];
  const nextMaxT = nextT[nextLen - 1];

  if (nextMinT > prevMaxT || nextMaxT < prevMinT) return indexOffset;

  const overlapMin = Math.max(prevMinT, nextMinT);
  const overlapMax = Math.min(prevMaxT, nextMaxT);
  const [pStart, pEnd] = clipToRange(prevSeg, overlapMin, overlapMax);
  const [nStart, nEnd] = clipToRange(nextSeg, overlapMin, overlapMax);
  if (pEnd < pStart || nEnd < nStart) return indexOffset;

  return triangulateClipped(
    prevSeg,
    nextSeg,
    prevBase,
    nextBase,
    pStart,
    pEnd,
    nStart,
    nEnd,
    indices,
    indexOffset,
  );
}

function countTrianglesBetweenSegments(
  prevSeg: WavefrontSegment,
  nextSeg: WavefrontSegment,
): number {
  const prevT = prevSeg.t;
  const prevLen = prevT.length;
  if (prevLen === 0) return 0;

  const nextT = nextSeg.t;
  const nextLen = nextT.length;
  if (nextLen === 0) return 0;

  const prevMinT = prevT[0];
  const prevMaxT = prevT[prevLen - 1];
  const nextMinT = nextT[0];
  const nextMaxT = nextT[nextLen - 1];
  if (nextMinT > prevMaxT || nextMaxT < prevMinT) return 0;

  const overlapMin = Math.max(prevMinT, nextMinT);
  const overlapMax = Math.min(prevMaxT, nextMaxT);
  const [pStart, pEnd] = clipToRange(prevSeg, overlapMin, overlapMax);
  const [nStart, nEnd] = clipToRange(nextSeg, overlapMin, overlapMax);
  if (pEnd < pStart || nEnd < nStart) return 0;
  return pEnd - pStart + (nEnd - nStart);
}

function computeCoverageQuad(bounds: WaveBounds, waveDx: number, waveDy: number) {
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
  return { x0, y0, x1, y1, x2, y2, x3, y3 };
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
      indices[indexOffset++] = prevBase + i;
      indices[indexOffset++] = nextBase + j;
      indices[indexOffset++] = nextBase + j + 1;
      j++;
    } else if (j >= nEnd) {
      indices[indexOffset++] = prevBase + i;
      indices[indexOffset++] = prevBase + i + 1;
      indices[indexOffset++] = nextBase + j;
      i++;
    } else {
      const currX = prevX[i];
      const currY = prevY[i];

      const scoreA = scoreTriangle(
        currX,
        currY,
        prevX[i + 1],
        prevY[i + 1],
        nextX[j],
        nextY[j],
      );

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
