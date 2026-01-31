/**
 * ShadowWorker: Web Worker for computing wave shadow geometry off the main thread.
 *
 * This worker receives coastline data and wave direction, then computes
 * shadow polygons using the same algorithm as WaveShadow, but asynchronously.
 */

import type {
  WorkerOutgoingMessage,
  WorkerRequest,
  WorkerResult,
} from "../../../core/workers/WorkerTypes";

// Inline Vector2D implementation for the worker
interface V2d {
  x: number;
  y: number;
}

// V function removed - using inline object literals instead

function dot(a: V2d, b: V2d): number {
  return a.x * b.x + a.y * b.y;
}

function add(a: V2d, b: V2d): V2d {
  return { x: a.x + b.x, y: a.y + b.y };
}

function mul(v: V2d, scalar: number): V2d {
  return { x: v.x * scalar, y: v.y * scalar };
}

// Inline Catmull-Rom spline functions
function catmullRomPoint(p0: V2d, p1: V2d, p2: V2d, p3: V2d, t: number): V2d {
  const t2 = t * t;
  const t3 = t2 * t;

  const v0 = mul({ x: p0.x, y: p0.y }, -t3 + 2 * t2 - t);
  const v1 = mul({ x: p1.x, y: p1.y }, 3 * t3 - 5 * t2 + 2);
  const v2 = mul({ x: p2.x, y: p2.y }, -3 * t3 + 4 * t2 + t);
  const v3 = mul({ x: p3.x, y: p3.y }, t3 - t2);

  return {
    x: (v0.x + v1.x + v2.x + v3.x) * 0.5,
    y: (v0.y + v1.y + v2.y + v3.y) * 0.5,
  };
}

// catmullRomTangent removed - using edge normals instead of tangent-based silhouette detection

// Shadow computation constants
const SAMPLES_PER_SEGMENT = 64; // Higher sampling for smoother polygons
const SHADOW_EXTENSION = 1000; // meters

// Request and result types
export interface ShadowComputeRequest extends WorkerRequest {
  type: "compute";
  coastlinePoints: V2d[];
  waveDirection: V2d;
}

export interface ShadowComputeResult extends WorkerResult {
  type: "result";
  shadowPolygons: V2d[][] | null; // Array of shadow polygons, null if no shadows computed
}

type ShadowMessage = WorkerOutgoingMessage<ShadowComputeResult>;

// Shadow computation using edge-normal classification

/**
 * Sample the Catmull-Rom spline to create a dense polygon.
 */
function sampleSplineToPolygon(
  controlPoints: V2d[],
  samplesPerSegment: number,
): V2d[] {
  const polygon: V2d[] = [];
  const n = controlPoints.length;

  for (let i = 0; i < n; i++) {
    const p0 = controlPoints[(i - 1 + n) % n];
    const p1 = controlPoints[i];
    const p2 = controlPoints[(i + 1) % n];
    const p3 = controlPoints[(i + 2) % n];

    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      polygon.push(catmullRomPoint(p0, p1, p2, p3, t));
    }
  }

  return polygon;
}

/**
 * Classify each edge as lit (facing waves) or shadow (facing away).
 */
function classifyEdges(polygon: V2d[], waveDir: V2d): boolean[] {
  const isShadowEdge: boolean[] = [];
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const v1 = polygon[i];
    const v2 = polygon[(i + 1) % n];
    const edge = { x: v2.x - v1.x, y: v2.y - v1.y };

    // Outward normal (rotate edge 90° clockwise)
    const normal = { x: edge.y, y: -edge.x };

    // Shadow edge if normal faces away from wave direction
    isShadowEdge.push(dot(normal, waveDir) < 0);
  }

  return isShadowEdge;
}

/**
 * Find vertices where edge classification changes (silhouette points).
 */
function findSilhouetteVertices(isShadowEdge: boolean[]): number[] {
  const silhouettes: number[] = [];
  const n = isShadowEdge.length;

  for (let i = 0; i < n; i++) {
    const prevEdge = isShadowEdge[(i - 1 + n) % n];
    const currEdge = isShadowEdge[i];

    // Silhouette when edge classification changes
    if (prevEdge !== currEdge) {
      silhouettes.push(i);
    }
  }

  return silhouettes;
}

/**
 * Build shadow polygons from shadow regions.
 */
function buildShadowPolygons(
  polygon: V2d[],
  isShadowEdge: boolean[],
  silhouettes: number[],
  waveDir: V2d,
): V2d[][] {
  const shadowPolygons: V2d[][] = [];

  // Process each silhouette pair
  for (let i = 0; i < silhouettes.length; i++) {
    const startIdx = silhouettes[i];
    const endIdx = silhouettes[(i + 1) % silhouettes.length];

    // Only process lit→shadow transitions (entering shadow region)
    if (!isShadowEdge[startIdx]) {
      continue;
    }

    // Collect leeward vertices (shadow edge vertices)
    const leewardVertices: V2d[] = [];
    let idx = startIdx;

    while (true) {
      leewardVertices.push(polygon[idx]);
      if (idx === endIdx) break;
      idx = (idx + 1) % polygon.length;
    }

    // Build shadow polygon
    const shadowVertices: V2d[] = [];

    // Extended vertices (far end of shadow)
    for (const v of leewardVertices) {
      shadowVertices.push(add(v, mul(waveDir, SHADOW_EXTENSION)));
    }

    // Leeward vertices (near end, reversed)
    for (let j = leewardVertices.length - 1; j >= 0; j--) {
      shadowVertices.push(leewardVertices[j]);
    }

    shadowPolygons.push(shadowVertices);
  }

  return shadowPolygons;
}

/**
 * Compute shadow geometry using edge-normal classification.
 * Returns array of shadow polygons (one per shadow region).
 */
function computeShadowGeometry(
  coastlinePoints: V2d[],
  waveDir: V2d,
): V2d[][] | null {
  if (coastlinePoints.length < 3) {
    return null;
  }

  // Step 1: Sample spline to polygon
  const polygon = sampleSplineToPolygon(coastlinePoints, SAMPLES_PER_SEGMENT);
  console.log(
    `[ShadowWorker] Sampled spline to ${polygon.length} point polygon`,
  );

  // Step 2: Classify edges as lit or shadow
  const isShadowEdge = classifyEdges(polygon, waveDir);
  const shadowEdgeCount = isShadowEdge.filter((s) => s).length;
  console.log(
    `[ShadowWorker] Found ${shadowEdgeCount} shadow edges (${((shadowEdgeCount / polygon.length) * 100).toFixed(1)}%)`,
  );

  // Step 3: Find silhouette vertices (where edge classification changes)
  const silhouettes = findSilhouetteVertices(isShadowEdge);
  console.log(`[ShadowWorker] Found ${silhouettes.length} silhouette vertices`);

  if (silhouettes.length === 0) {
    return null;
  }

  // Step 4: Build shadow polygons for each shadow region
  const shadowPolygons = buildShadowPolygons(
    polygon,
    isShadowEdge,
    silhouettes,
    waveDir,
  );

  if (shadowPolygons.length === 0) {
    return null;
  }

  console.log(
    `[ShadowWorker] Generated ${shadowPolygons.length} shadow polygon(s)`,
  );

  return shadowPolygons;
}

// Worker message handler
self.addEventListener("message", (event: MessageEvent) => {
  const request = event.data as ShadowComputeRequest;

  if (request.type === "compute") {
    try {
      const shadowPolygons = computeShadowGeometry(
        request.coastlinePoints,
        request.waveDirection,
      );

      const result: ShadowComputeResult = {
        type: "result",
        batchId: request.batchId,
        shadowPolygons,
      };

      self.postMessage(result as ShadowMessage);
    } catch (error) {
      const errorMsg = {
        type: "error",
        batchId: request.batchId,
        message: (error as Error).message,
      };

      self.postMessage(errorMsg);
    }
  }
});

// Send ready signal
self.postMessage({ type: "ready" });
