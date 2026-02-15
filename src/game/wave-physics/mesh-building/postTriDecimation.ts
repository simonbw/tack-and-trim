import { DEFAULT_DECIMATION_TOLERANCE } from "./decimation";
import type { WavefrontMeshData } from "./MeshBuildTypes";
import { VERTEX_FLOATS } from "./marchingTypes";

const POSITION_X = 0;
const POSITION_Y = 1;
const AMPLITUDE = 2;
const PHASE_OFFSET = 4;
const BLEND_WEIGHT = 5;

const BARY_EPS = 1e-5;
const MIN_TRIANGLE_AREA = 1e-4;
const MIN_POLYGON_AREA = 1e-4;

type RejectReason = "boundary" | "topology" | "degenerate" | "error";

interface MutableTriangle {
  a: number;
  b: number;
  c: number;
  active: boolean;
}

interface RemovableCandidate {
  vertex: number;
  score: number;
  version: number;
}

interface CandidateEvaluationFailure {
  removable: false;
  reason: RejectReason;
}

interface CandidateEvaluationSuccess {
  removable: true;
  score: number;
  incidentTriangles: number[];
  retriangulated: [number, number, number][];
}

type CandidateEvaluation = CandidateEvaluationFailure | CandidateEvaluationSuccess;

interface SamplePoint {
  x: number;
  y: number;
  oldPc: number;
  oldPs: number;
}

export type PostTriBudgetStopReason =
  | "none"
  | "time"
  | "evaluations"
  | "removals";

export interface PostTriDecimationOptions {
  tolerance?: number;
  maxDecimationTimeMs?: number;
  maxCandidateEvaluations?: number;
  maxRemovals?: number;
}

export interface PostTriDecimationStats {
  inputVertices: number;
  inputTriangles: number;
  outputVertices: number;
  outputTriangles: number;
  removedVertices: number;
  lockedBoundaryVertices: number;
  candidateEvaluations: number;
  staleCandidates: number;
  rejectedBoundary: number;
  rejectedTopology: number;
  rejectedDegenerate: number;
  rejectedError: number;
  budgetStopReason: PostTriBudgetStopReason;
  budgetMaxDecimationTimeMs: number | null;
  budgetMaxCandidateEvaluations: number | null;
  budgetMaxRemovals: number | null;
  decimationTimeMs: number;
  compactionTimeMs: number;
  totalTimeMs: number;
}

export interface PostTriDecimationResult {
  meshData: WavefrontMeshData;
  stats: PostTriDecimationStats;
}

class CandidateHeap {
  private readonly data: RemovableCandidate[] = [];

  get size(): number {
    return this.data.length;
  }

  push(candidate: RemovableCandidate): void {
    this.data.push(candidate);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): RemovableCandidate | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const tail = this.data.pop();
    if (!tail) return top;
    if (this.data.length > 0) {
      this.data[0] = tail;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.isHigherPriority(this.data[parent], this.data[index])) break;
      [this.data[parent], this.data[index]] = [
        this.data[index],
        this.data[parent],
      ];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const size = this.data.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;

      if (
        left < size &&
        this.isHigherPriority(this.data[left], this.data[best])
      ) {
        best = left;
      }
      if (
        right < size &&
        this.isHigherPriority(this.data[right], this.data[best])
      ) {
        best = right;
      }
      if (best === index) break;
      [this.data[index], this.data[best]] = [this.data[best], this.data[index]];
      index = best;
    }
  }

  private isHigherPriority(
    a: RemovableCandidate,
    b: RemovableCandidate,
  ): boolean {
    if (a.score !== b.score) return a.score < b.score;
    return a.vertex < b.vertex;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getFloat(vertices: Float32Array, vertex: number, attribute: number): number {
  return vertices[vertex * VERTEX_FLOATS + attribute];
}

function getX(vertices: Float32Array, vertex: number): number {
  return getFloat(vertices, vertex, POSITION_X);
}

function getY(vertices: Float32Array, vertex: number): number {
  return getFloat(vertices, vertex, POSITION_Y);
}

function getAmplitude(vertices: Float32Array, vertex: number): number {
  return getFloat(vertices, vertex, AMPLITUDE);
}

function getPhase(vertices: Float32Array, vertex: number): number {
  return getFloat(vertices, vertex, PHASE_OFFSET);
}

function getBlend(vertices: Float32Array, vertex: number): number {
  return getFloat(vertices, vertex, BLEND_WEIGHT);
}

function triangleArea(
  vertices: Float32Array,
  a: number,
  b: number,
  c: number,
): number {
  const ax = getX(vertices, a);
  const ay = getY(vertices, a);
  const bx = getX(vertices, b);
  const by = getY(vertices, b);
  const cx = getX(vertices, c);
  const cy = getY(vertices, c);
  return 0.5 * Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

function signedPolygonArea(vertices: Float32Array, polygon: number[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += getX(vertices, a) * getY(vertices, b) - getY(vertices, a) * getX(vertices, b);
  }
  return 0.5 * sum;
}

function triangleCompactnessScore(
  vertices: Float32Array,
  a: number,
  b: number,
  c: number,
): number {
  const ax = getX(vertices, a);
  const ay = getY(vertices, a);
  const bx = getX(vertices, b);
  const by = getY(vertices, b);
  const cx = getX(vertices, c);
  const cy = getY(vertices, c);
  const dx1 = bx - ax;
  const dy1 = by - ay;
  const dx2 = cx - bx;
  const dy2 = cy - by;
  const dx3 = ax - cx;
  const dy3 = ay - cy;
  return dx1 * dx1 + dy1 * dy1 + dx2 * dx2 + dy2 * dy2 + dx3 * dx3 + dy3 * dy3;
}

function orientedCross(
  vertices: Float32Array,
  a: number,
  b: number,
  c: number,
): number {
  const ax = getX(vertices, a);
  const ay = getY(vertices, a);
  const bx = getX(vertices, b);
  const by = getY(vertices, b);
  const cx = getX(vertices, c);
  const cy = getY(vertices, c);
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function barycentricWeights(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): { wa: number; wb: number; wc: number } | null {
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denom) <= 1e-12) return null;
  const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom;
  const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom;
  const wc = 1 - wa - wb;
  return { wa, wb, wc };
}

function isPointInsideTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const bary = barycentricWeights(px, py, ax, ay, bx, by, cx, cy);
  if (!bary) return false;
  return bary.wa >= -BARY_EPS && bary.wb >= -BARY_EPS && bary.wc >= -BARY_EPS;
}

function isPointInPolygon(
  vertices: Float32Array,
  polygon: number[],
  px: number,
  py: number,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const vi = polygon[i];
    const vj = polygon[j];
    const xi = getX(vertices, vi);
    const yi = getY(vertices, vi);
    const xj = getX(vertices, vj);
    const yj = getY(vertices, vj);

    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function interpolatePhasorInTriangle(
  vertices: Float32Array,
  triangle: [number, number, number],
  x: number,
  y: number,
): { pc: number; ps: number } | null {
  const [a, b, c] = triangle;
  const ax = getX(vertices, a);
  const ay = getY(vertices, a);
  const bx = getX(vertices, b);
  const by = getY(vertices, b);
  const cx = getX(vertices, c);
  const cy = getY(vertices, c);
  const bary = barycentricWeights(x, y, ax, ay, bx, by, cx, cy);
  if (!bary) return null;
  if (bary.wa < -BARY_EPS || bary.wb < -BARY_EPS || bary.wc < -BARY_EPS) {
    return null;
  }

  const wa = clamp(bary.wa, 0, 1);
  const wb = clamp(bary.wb, 0, 1);
  const wc = clamp(bary.wc, 0, 1);
  const inv = 1 / Math.max(wa + wb + wc, 1e-8);
  const nwa = wa * inv;
  const nwb = wb * inv;
  const nwc = wc * inv;

  const amp =
    nwa * getAmplitude(vertices, a) +
    nwb * getAmplitude(vertices, b) +
    nwc * getAmplitude(vertices, c);
  const phase =
    nwa * getPhase(vertices, a) +
    nwb * getPhase(vertices, b) +
    nwc * getPhase(vertices, c);
  const blend =
    nwa * getBlend(vertices, a) +
    nwb * getBlend(vertices, b) +
    nwc * getBlend(vertices, c);

  return {
    pc: amp * Math.cos(phase) * blend,
    ps: amp * Math.sin(phase) * blend,
  };
}

function interpolatePhasorFromPatch(
  vertices: Float32Array,
  triangles: [number, number, number][],
  x: number,
  y: number,
): { pc: number; ps: number } | null {
  for (const tri of triangles) {
    const phasor = interpolatePhasorInTriangle(vertices, tri, x, y);
    if (phasor) return phasor;
  }
  return null;
}

function buildSamplePoints(
  vertices: Float32Array,
  removedVertex: number,
  incidentTriangles: number[],
  triangles: MutableTriangle[],
): SamplePoint[] {
  const samples: SamplePoint[] = [];

  const amp = getAmplitude(vertices, removedVertex);
  const phase = getPhase(vertices, removedVertex);
  const blend = getBlend(vertices, removedVertex);
  samples.push({
    x: getX(vertices, removedVertex),
    y: getY(vertices, removedVertex),
    oldPc: amp * Math.cos(phase) * blend,
    oldPs: amp * Math.sin(phase) * blend,
  });

  for (const triIdx of incidentTriangles) {
    const tri = triangles[triIdx];
    const a = tri.a;
    const b = tri.b;
    const c = tri.c;
    const x = (getX(vertices, a) + getX(vertices, b) + getX(vertices, c)) / 3;
    const y = (getY(vertices, a) + getY(vertices, b) + getY(vertices, c)) / 3;
    const old = interpolatePhasorInTriangle(vertices, [a, b, c], x, y);
    if (!old) continue;
    samples.push({ x, y, oldPc: old.pc, oldPs: old.ps });
  }

  return samples;
}

function orderedHoleRing(
  removedVertex: number,
  incidentTriangles: number[],
  triangles: MutableTriangle[],
): number[] | null {
  const adjacency = new Map<number, number[]>();
  const edgeMultiplicity = new Map<string, number>();

  const addNeighbor = (from: number, to: number): boolean => {
    const list = adjacency.get(from);
    if (!list) {
      adjacency.set(from, [to]);
      return true;
    }
    if (list.includes(to)) return false;
    list.push(to);
    return true;
  };

  for (const triIdx of incidentTriangles) {
    const tri = triangles[triIdx];
    if (!tri.active) return null;

    let u = -1;
    let w = -1;
    if (tri.a === removedVertex) {
      u = tri.b;
      w = tri.c;
    } else if (tri.b === removedVertex) {
      u = tri.c;
      w = tri.a;
    } else if (tri.c === removedVertex) {
      u = tri.a;
      w = tri.b;
    } else {
      return null;
    }

    if (u === w || u < 0 || w < 0) return null;
    const key = u < w ? `${u}:${w}` : `${w}:${u}`;
    edgeMultiplicity.set(key, (edgeMultiplicity.get(key) ?? 0) + 1);
    if (!addNeighbor(u, w)) return null;
    if (!addNeighbor(w, u)) return null;
  }

  if (adjacency.size < 3) return null;
  if (edgeMultiplicity.size !== incidentTriangles.length) return null;
  for (const count of edgeMultiplicity.values()) {
    if (count !== 1) return null;
  }
  for (const neighbors of adjacency.values()) {
    if (neighbors.length !== 2) return null;
  }

  let start = -1;
  for (const vertex of adjacency.keys()) {
    if (start === -1 || vertex < start) start = vertex;
  }
  if (start < 0) return null;

  const ring: number[] = [];
  let previous = -1;
  let current = start;
  const expectedLength = adjacency.size;
  for (let i = 0; i <= expectedLength; i++) {
    ring.push(current);
    const neighbors = adjacency.get(current);
    if (!neighbors || neighbors.length !== 2) return null;
    let next = neighbors[0];
    if (next === previous) {
      next = neighbors[1];
    }
    if (next === previous || next < 0) return null;
    previous = current;
    current = next;
    if (current === start) break;
  }

  if (current !== start) return null;
  if (ring.length !== expectedLength) return null;
  return ring;
}

function triangulateFanPolygon(
  vertices: Float32Array,
  polygon: number[],
): [number, number, number][] | null {
  if (polygon.length < 3) return null;
  let best: [number, number, number][] | null = null;
  let bestWorstScore = Number.POSITIVE_INFINITY;

  for (let anchorOffset = 0; anchorOffset < polygon.length; anchorOffset++) {
    const sequence: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      sequence.push(polygon[(anchorOffset + i) % polygon.length]);
    }
    const anchor = sequence[0];
    const triangles: [number, number, number][] = [];
    let worstScore = 0;
    let valid = true;

    for (let i = 1; i < sequence.length - 1; i++) {
      const tri: [number, number, number] = [anchor, sequence[i], sequence[i + 1]];
      if (triangleArea(vertices, tri[0], tri[1], tri[2]) <= MIN_TRIANGLE_AREA) {
        valid = false;
        break;
      }
      const centroidX =
        (getX(vertices, tri[0]) + getX(vertices, tri[1]) + getX(vertices, tri[2])) /
        3;
      const centroidY =
        (getY(vertices, tri[0]) + getY(vertices, tri[1]) + getY(vertices, tri[2])) /
        3;
      if (!isPointInPolygon(vertices, polygon, centroidX, centroidY)) {
        valid = false;
        break;
      }
      const score = triangleCompactnessScore(vertices, tri[0], tri[1], tri[2]);
      if (score > worstScore) worstScore = score;
      triangles.push(tri);
    }

    if (!valid) continue;
    if (worstScore < bestWorstScore) {
      bestWorstScore = worstScore;
      best = triangles;
    }
  }

  return best;
}

function triangulateHole(
  vertices: Float32Array,
  ring: number[],
): [number, number, number][] | null {
  if (ring.length < 3) return null;
  if (Math.abs(signedPolygonArea(vertices, ring)) < MIN_POLYGON_AREA) return null;

  const polygon = ring.slice();
  const triangles: [number, number, number][] = [];
  const orientation = signedPolygonArea(vertices, polygon) > 0 ? 1 : -1;

  const maxIterations = ring.length * ring.length * 2;
  let iterations = 0;

  while (polygon.length > 3) {
    iterations++;
    if (iterations > maxIterations) {
      const fan = triangulateFanPolygon(vertices, polygon);
      if (!fan) return null;
      triangles.push(...fan);
      return triangles;
    }

    let bestEarIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestEarTriangle: [number, number, number] | null = null;

    for (let i = 0; i < polygon.length; i++) {
      const prev = polygon[(i + polygon.length - 1) % polygon.length];
      const curr = polygon[i];
      const next = polygon[(i + 1) % polygon.length];

      const cross = orientedCross(vertices, prev, curr, next);
      if (orientation > 0) {
        if (cross <= BARY_EPS) continue;
      } else if (cross >= -BARY_EPS) {
        continue;
      }

      if (triangleArea(vertices, prev, curr, next) <= MIN_TRIANGLE_AREA) continue;

      const ax = getX(vertices, prev);
      const ay = getY(vertices, prev);
      const bx = getX(vertices, curr);
      const by = getY(vertices, curr);
      const cx = getX(vertices, next);
      const cy = getY(vertices, next);
      let containsOther = false;
      for (let j = 0; j < polygon.length; j++) {
        const p = polygon[j];
        if (p === prev || p === curr || p === next) continue;
        if (
          isPointInsideTriangle(
            getX(vertices, p),
            getY(vertices, p),
            ax,
            ay,
            bx,
            by,
            cx,
            cy,
          )
        ) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;

      const tri: [number, number, number] = [prev, curr, next];
      const score = triangleCompactnessScore(vertices, tri[0], tri[1], tri[2]);
      if (score < bestScore) {
        bestScore = score;
        bestEarIndex = i;
        bestEarTriangle = tri;
      }
    }

    if (bestEarIndex === -1 || !bestEarTriangle) {
      const fan = triangulateFanPolygon(vertices, polygon);
      if (!fan) return null;
      triangles.push(...fan);
      return triangles;
    }

    triangles.push(bestEarTriangle);
    polygon.splice(bestEarIndex, 1);
  }

  if (polygon.length !== 3) return null;
  if (triangleArea(vertices, polygon[0], polygon[1], polygon[2]) <= MIN_TRIANGLE_AREA) {
    return null;
  }
  triangles.push([polygon[0], polygon[1], polygon[2]]);
  return triangles;
}

function evaluateRemovalCandidate(
  vertex: number,
  vertices: Float32Array,
  triangles: MutableTriangle[],
  vertexTriangles: Array<Set<number>>,
  removed: Uint8Array,
  locked: Uint8Array,
  tolerance: number,
): CandidateEvaluation {
  if (removed[vertex] !== 0 || locked[vertex] !== 0) {
    return { removable: false, reason: "boundary" };
  }

  const incidentTriangles = [...vertexTriangles[vertex]].filter(
    (triIdx) => triangles[triIdx]?.active === true,
  );
  if (incidentTriangles.length < 3) {
    return { removable: false, reason: "topology" };
  }

  const ring = orderedHoleRing(vertex, incidentTriangles, triangles);
  if (!ring || ring.length < 3) {
    return { removable: false, reason: "topology" };
  }

  const retriangulated = triangulateHole(vertices, ring);
  if (!retriangulated || retriangulated.length === 0) {
    return { removable: false, reason: "degenerate" };
  }

  for (const tri of retriangulated) {
    if (triangleArea(vertices, tri[0], tri[1], tri[2]) <= MIN_TRIANGLE_AREA) {
      return { removable: false, reason: "degenerate" };
    }
  }

  const samples = buildSamplePoints(vertices, vertex, incidentTriangles, triangles);
  if (samples.length === 0) {
    return { removable: false, reason: "topology" };
  }

  let maxError = 0;
  for (const sample of samples) {
    const next = interpolatePhasorFromPatch(
      vertices,
      retriangulated,
      sample.x,
      sample.y,
    );
    if (!next) {
      return { removable: false, reason: "topology" };
    }
    const dpc = next.pc - sample.oldPc;
    const dps = next.ps - sample.oldPs;
    const oldMag = Math.hypot(sample.oldPc, sample.oldPs);
    const denom = Math.max(oldMag, 1e-4);
    const error = Math.hypot(dpc, dps) / denom;
    if (error > maxError) maxError = error;
    if (maxError > tolerance) {
      return { removable: false, reason: "error" };
    }
  }

  return {
    removable: true,
    score: maxError,
    incidentTriangles,
    retriangulated,
  };
}

function shouldStopForBudget(
  stats: PostTriDecimationStats,
  decimationStartMs: number,
  maxDecimationTimeMs: number | undefined,
  maxCandidateEvaluations: number | undefined,
  maxRemovals: number | undefined,
  stopReason: { value: PostTriBudgetStopReason },
): boolean {
  if (stopReason.value !== "none") return true;

  if (
    maxDecimationTimeMs !== undefined &&
    performance.now() - decimationStartMs >= maxDecimationTimeMs
  ) {
    stopReason.value = "time";
    return true;
  }

  if (
    maxCandidateEvaluations !== undefined &&
    stats.candidateEvaluations >= maxCandidateEvaluations
  ) {
    stopReason.value = "evaluations";
    return true;
  }

  if (maxRemovals !== undefined && stats.removedVertices >= maxRemovals) {
    stopReason.value = "removals";
    return true;
  }

  return false;
}

function queueCandidate(
  vertex: number,
  vertices: Float32Array,
  triangles: MutableTriangle[],
  vertexTriangles: Array<Set<number>>,
  removed: Uint8Array,
  locked: Uint8Array,
  versions: Uint32Array,
  tolerance: number,
  heap: CandidateHeap,
  stats: PostTriDecimationStats,
  decimationStartMs: number,
  maxDecimationTimeMs: number | undefined,
  maxCandidateEvaluations: number | undefined,
  maxRemovals: number | undefined,
  stopReason: { value: PostTriBudgetStopReason },
): boolean {
  if (vertex < 0 || vertex >= removed.length) return true;
  if (removed[vertex] !== 0 || locked[vertex] !== 0) return true;

  if (
    shouldStopForBudget(
      stats,
      decimationStartMs,
      maxDecimationTimeMs,
      maxCandidateEvaluations,
      maxRemovals,
      stopReason,
    )
  ) {
    return false;
  }

  stats.candidateEvaluations++;
  const evalResult = evaluateRemovalCandidate(
    vertex,
    vertices,
    triangles,
    vertexTriangles,
    removed,
    locked,
    tolerance,
  );

  if (!evalResult.removable) {
    if (evalResult.reason === "boundary") stats.rejectedBoundary++;
    else if (evalResult.reason === "topology") stats.rejectedTopology++;
    else if (evalResult.reason === "degenerate") stats.rejectedDegenerate++;
    else stats.rejectedError++;
    return true;
  }

  heap.push({ vertex, score: evalResult.score, version: versions[vertex] });
  return true;
}

function expandAffectedVertices(
  verticesToExpand: Set<number>,
  triangles: MutableTriangle[],
  vertexTriangles: Array<Set<number>>,
): Set<number> {
  const expanded = new Set<number>(verticesToExpand);
  for (const vertex of verticesToExpand) {
    for (const triIdx of vertexTriangles[vertex]) {
      const tri = triangles[triIdx];
      if (!tri?.active) continue;
      expanded.add(tri.a);
      expanded.add(tri.b);
      expanded.add(tri.c);
    }
  }
  return expanded;
}

function compactMeshData(
  source: WavefrontMeshData,
  triangles: MutableTriangle[],
  removed: Uint8Array,
): WavefrontMeshData {
  const oldVertices = source.vertices;
  const vertexCount = source.vertexCount;
  const used = new Uint8Array(vertexCount);
  const activeTriangles: MutableTriangle[] = [];

  for (const tri of triangles) {
    if (!tri.active) continue;
    if (removed[tri.a] !== 0 || removed[tri.b] !== 0 || removed[tri.c] !== 0) {
      continue;
    }
    if (triangleArea(oldVertices, tri.a, tri.b, tri.c) <= MIN_TRIANGLE_AREA) {
      continue;
    }
    activeTriangles.push(tri);
    used[tri.a] = 1;
    used[tri.b] = 1;
    used[tri.c] = 1;
  }

  let outputVertexCount = 0;
  const remap = new Int32Array(vertexCount);
  remap.fill(-1);
  for (let v = 0; v < vertexCount; v++) {
    if (used[v] === 0) continue;
    remap[v] = outputVertexCount++;
  }

  const outputVertices = new Float32Array(outputVertexCount * VERTEX_FLOATS);
  for (let oldV = 0; oldV < vertexCount; oldV++) {
    const newV = remap[oldV];
    if (newV < 0) continue;
    const srcBase = oldV * VERTEX_FLOATS;
    const dstBase = newV * VERTEX_FLOATS;
    for (let k = 0; k < VERTEX_FLOATS; k++) {
      outputVertices[dstBase + k] = oldVertices[srcBase + k];
    }
  }

  const outputIndices = new Uint32Array(activeTriangles.length * 3);
  let cursor = 0;
  for (const tri of activeTriangles) {
    const a = remap[tri.a];
    const b = remap[tri.b];
    const c = remap[tri.c];
    if (a < 0 || b < 0 || c < 0) continue;
    outputIndices[cursor++] = a;
    outputIndices[cursor++] = b;
    outputIndices[cursor++] = c;
  }

  const coverageQuad = source.coverageQuad
    ? { ...source.coverageQuad }
    : null;

  return {
    vertices: outputVertices,
    indices: outputIndices.subarray(0, cursor),
    vertexCount: outputVertexCount,
    indexCount: cursor,
    coverageQuad,
  };
}

export function decimateTriangulatedMesh(
  source: WavefrontMeshData,
  options: number | PostTriDecimationOptions = DEFAULT_DECIMATION_TOLERANCE,
): PostTriDecimationResult {
  const tStart = performance.now();
  const tolerance =
    typeof options === "number"
      ? options
      : (options.tolerance ?? DEFAULT_DECIMATION_TOLERANCE);
  const maxDecimationTimeMs =
    typeof options === "number" ? undefined : options.maxDecimationTimeMs;
  const maxCandidateEvaluations =
    typeof options === "number" ? undefined : options.maxCandidateEvaluations;
  const maxRemovals =
    typeof options === "number" ? undefined : options.maxRemovals;

  const stats: PostTriDecimationStats = {
    inputVertices: source.vertexCount,
    inputTriangles: Math.floor(source.indexCount / 3),
    outputVertices: source.vertexCount,
    outputTriangles: Math.floor(source.indexCount / 3),
    removedVertices: 0,
    lockedBoundaryVertices: 0,
    candidateEvaluations: 0,
    staleCandidates: 0,
    rejectedBoundary: 0,
    rejectedTopology: 0,
    rejectedDegenerate: 0,
    rejectedError: 0,
    budgetStopReason: "none",
    budgetMaxDecimationTimeMs: maxDecimationTimeMs ?? null,
    budgetMaxCandidateEvaluations: maxCandidateEvaluations ?? null,
    budgetMaxRemovals: maxRemovals ?? null,
    decimationTimeMs: 0,
    compactionTimeMs: 0,
    totalTimeMs: 0,
  };

  if (source.vertexCount === 0 || source.indexCount === 0 || tolerance <= 0) {
    stats.totalTimeMs = performance.now() - tStart;
    return { meshData: source, stats };
  }

  const triangles: MutableTriangle[] = [];
  const vertexTriangles: Array<Set<number>> = Array.from(
    { length: source.vertexCount },
    () => new Set<number>(),
  );
  for (let i = 0; i < source.indexCount; i += 3) {
    const a = source.indices[i];
    const b = source.indices[i + 1];
    const c = source.indices[i + 2];
    if (
      a < 0 ||
      b < 0 ||
      c < 0 ||
      a >= source.vertexCount ||
      b >= source.vertexCount ||
      c >= source.vertexCount
    ) {
      continue;
    }
    if (a === b || b === c || c === a) continue;
    const triIdx = triangles.length;
    triangles.push({ a, b, c, active: true });
    vertexTriangles[a].add(triIdx);
    vertexTriangles[b].add(triIdx);
    vertexTriangles[c].add(triIdx);
  }

  const removed = new Uint8Array(source.vertexCount);
  const locked = new Uint8Array(source.vertexCount);
  for (let v = 0; v < source.vertexCount; v++) {
    if (getBlend(source.vertices, v) <= 1e-6) {
      locked[v] = 1;
      stats.lockedBoundaryVertices++;
    }
  }

  const versions = new Uint32Array(source.vertexCount);
  const heap = new CandidateHeap();
  const stopReason = { value: "none" as PostTriBudgetStopReason };
  const tDecimateStart = performance.now();

  for (let v = 0; v < source.vertexCount; v++) {
    const shouldContinue = queueCandidate(
      v,
      source.vertices,
      triangles,
      vertexTriangles,
      removed,
      locked,
      versions,
      tolerance,
      heap,
      stats,
      tDecimateStart,
      maxDecimationTimeMs,
      maxCandidateEvaluations,
      maxRemovals,
      stopReason,
    );
    if (!shouldContinue && stopReason.value !== "none") {
      break;
    }
  }

  while (heap.size > 0 && stopReason.value === "none") {
    if (
      shouldStopForBudget(
        stats,
        tDecimateStart,
        maxDecimationTimeMs,
        maxCandidateEvaluations,
        maxRemovals,
        stopReason,
      )
    ) {
      break;
    }

    const candidate = heap.pop();
    if (!candidate) break;
    const vertex = candidate.vertex;

    if (removed[vertex] !== 0 || locked[vertex] !== 0) continue;
    if (candidate.version !== versions[vertex]) {
      stats.staleCandidates++;
      continue;
    }

    if (
      shouldStopForBudget(
        stats,
        tDecimateStart,
        maxDecimationTimeMs,
        maxCandidateEvaluations,
        maxRemovals,
        stopReason,
      )
    ) {
      break;
    }

    stats.candidateEvaluations++;
    const evalResult = evaluateRemovalCandidate(
      vertex,
      source.vertices,
      triangles,
      vertexTriangles,
      removed,
      locked,
      tolerance,
    );

    if (!evalResult.removable) {
      if (evalResult.reason === "boundary") stats.rejectedBoundary++;
      else if (evalResult.reason === "topology") stats.rejectedTopology++;
      else if (evalResult.reason === "degenerate") stats.rejectedDegenerate++;
      else stats.rejectedError++;
      continue;
    }

    // Removal became invalid only if stale; with a fresh version this should hold.
    if (evalResult.score > tolerance) {
      stats.rejectedError++;
      continue;
    }

    const affected = new Set<number>();
    for (const triIdx of evalResult.incidentTriangles) {
      const tri = triangles[triIdx];
      if (!tri?.active) continue;
      tri.active = false;
      vertexTriangles[tri.a].delete(triIdx);
      vertexTriangles[tri.b].delete(triIdx);
      vertexTriangles[tri.c].delete(triIdx);
      if (tri.a !== vertex) affected.add(tri.a);
      if (tri.b !== vertex) affected.add(tri.b);
      if (tri.c !== vertex) affected.add(tri.c);
    }

    removed[vertex] = 1;
    vertexTriangles[vertex].clear();
    versions[vertex]++;

    for (const tri of evalResult.retriangulated) {
      const triIdx = triangles.length;
      triangles.push({
        a: tri[0],
        b: tri[1],
        c: tri[2],
        active: true,
      });
      vertexTriangles[tri[0]].add(triIdx);
      vertexTriangles[tri[1]].add(triIdx);
      vertexTriangles[tri[2]].add(triIdx);
      affected.add(tri[0]);
      affected.add(tri[1]);
      affected.add(tri[2]);
    }

    stats.removedVertices++;

    const expanded = expandAffectedVertices(affected, triangles, vertexTriangles);
    for (const v of expanded) {
      if (v === vertex) continue;
      versions[v]++;
      const shouldContinue = queueCandidate(
        v,
        source.vertices,
        triangles,
        vertexTriangles,
        removed,
        locked,
        versions,
        tolerance,
        heap,
        stats,
        tDecimateStart,
        maxDecimationTimeMs,
        maxCandidateEvaluations,
        maxRemovals,
        stopReason,
      );
      if (!shouldContinue && stopReason.value !== "none") {
        break;
      }
    }
  }
  const tDecimateEnd = performance.now();
  stats.decimationTimeMs = tDecimateEnd - tDecimateStart;
  stats.budgetStopReason = stopReason.value;

  const tCompactStart = performance.now();
  const meshData = compactMeshData(source, triangles, removed);
  const tCompactEnd = performance.now();
  stats.compactionTimeMs = tCompactEnd - tCompactStart;
  stats.totalTimeMs = tCompactEnd - tStart;
  stats.outputVertices = meshData.vertexCount;
  stats.outputTriangles = Math.floor(meshData.indexCount / 3);

  return { meshData, stats };
}
