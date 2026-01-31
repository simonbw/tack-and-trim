import { clamp } from "../../util/MathUtil";
import { V, V2d } from "../../Vector";

const MIN_CIRCLE_SEGMENTS = 4;
const MAX_CIRCLE_SEGMENTS = 64;

// Number of circle segments based on radius
function getCircleSegments(radius: number): number {
  return clamp(
    Math.floor(radius * 4),
    MIN_CIRCLE_SEGMENTS,
    MAX_CIRCLE_SEGMENTS,
  );
}

// Cache for pre-computed unit circle vertices
// Key: segment count, Value: array of [cos(angle), sin(angle)] for each vertex
const circleCache = new Map<number, { cos: Float32Array; sin: Float32Array }>();

function getCircleVertices(segments: number): {
  cos: Float32Array;
  sin: Float32Array;
} {
  let cached = circleCache.get(segments);
  if (!cached) {
    const cos = new Float32Array(segments + 1);
    const sin = new Float32Array(segments + 1);
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      cos[i] = Math.cos(angle);
      sin[i] = Math.sin(angle);
    }
    cached = { cos, sin };
    circleCache.set(segments, cached);
  }
  return cached;
}

// Pools for reusable vertex and index arrays (avoids allocations per fillCircle call)
const circleVertexPool = new Map<number, V2d[]>();
const circleIndexPool = new Map<number, number[]>();

/**
 * Get or create pooled vertex/index arrays for circles with a given segment count.
 * This avoids allocating new arrays on every fillCircle call.
 */
function getCircleArrays(segments: number): {
  vertices: V2d[];
  indices: number[];
} {
  let vertices = circleVertexPool.get(segments);
  let indices = circleIndexPool.get(segments);

  if (!vertices) {
    // Allocate vertices: center + perimeter points
    vertices = [V(0, 0)]; // Center
    for (let i = 0; i <= segments; i++) {
      vertices.push(V(0, 0));
    }
    circleVertexPool.set(segments, vertices);
  }

  if (!indices) {
    indices = [];
    for (let i = 1; i <= segments; i++) {
      indices.push(0, i, i + 1 > segments ? 1 : i + 1);
    }
    circleIndexPool.set(segments, indices);
  }

  return { vertices, indices };
}

export { getCircleSegments, getCircleVertices, getCircleArrays };
