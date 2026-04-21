/**
 * Tessellation utilities for converting 3D boat geometry (lines, polylines,
 * rectangles, circles) into triangle meshes with per-vertex z-values.
 *
 * All functions produce data suitable for WebGPURenderer.submitTrianglesWithZ().
 */

export {
  computeTiltProjection,
  type TiltProjection,
} from "../../core/graphics/TiltProjection";
import type { TiltProjection } from "../../core/graphics/TiltProjection";

export {
  roundCorners,
  subdivideSmooth,
  subdivideCatmullRom,
  catmullRomOutputCount,
} from "../../core/graphics/tessellation/curves";

/** A batch of triangles with per-vertex z, ready for submitTrianglesWithZ. */
export interface MeshContribution {
  positions: [number, number][];
  zValues: number[];
  indices: number[];
  color: number;
  alpha: number;
}

/**
 * Tessellate a 3D line segment into a quad (2 triangles) with per-vertex z.
 * The quad is oriented perpendicular to the line's XY projection.
 */
export function tessellateLineToQuad(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  width: number,
  color: number,
  alpha: number = 1,
): MeshContribution {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);

  const hw = width / 2;
  let nx: number, ny: number;
  if (len < 1e-6) {
    // Purely vertical line (same XY, different z) — use arbitrary perpendicular.
    // The tilt context zCoeffs will spread vertices apart on screen.
    nx = hw;
    ny = 0;
  } else {
    nx = (-dy / len) * hw;
    ny = (dx / len) * hw;
  }

  return {
    positions: [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ],
    zValues: [z1, z2, z2, z1],
    indices: [0, 1, 2, 0, 2, 3],
    color,
    alpha,
  };
}

/**
 * Tessellate a 3D line into a quad with constant screen-space width.
 * For cylindrical objects (mast, boom, rigging, stanchions) whose visual
 * width shouldn't depend on the boat's tilt orientation.
 *
 * Computes the projected line direction on screen, finds the screen-space
 * perpendicular, then inverse-transforms it to hull-local space so the GPU
 * tilt projection produces the desired constant width.
 */
export function tessellateScreenWidthLine(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  width: number,
  tilt: TiltProjection,
  color: number,
  alpha: number = 1,
  roundCaps: boolean = false,
): MeshContribution {
  // Project line direction to screen space
  const dlx = x2 - x1;
  const dly = y2 - y1;
  const dlz = z2 - z1;
  const dsx = tilt.m00 * dlx + tilt.m01 * dly + tilt.zx * dlz;
  const dsy = tilt.m10 * dlx + tilt.m11 * dly + tilt.zy * dlz;

  // Screen-space perpendicular (normalized)
  const sLen = Math.sqrt(dsx * dsx + dsy * dsy);
  if (sLen < 1e-6) {
    return { positions: [], zValues: [], indices: [], color, alpha };
  }
  const hw = width / 2;
  const spx = (-dsy / sLen) * hw;
  const spy = (dsx / sLen) * hw;

  // Inverse-transform screen perpendicular to hull-local offset
  const nx = tilt.inv00 * spx + tilt.inv01 * spy;
  const ny = tilt.inv10 * spx + tilt.inv11 * spy;

  const positions: [number, number][] = [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ];
  const zValues = [z1, z2, z2, z1];
  const indices = [0, 1, 2, 0, 2, 3];

  if (roundCaps) {
    const perpAngle = Math.atan2(spy, spx);
    const capSteps = 8;

    // Helper: add a semicircular cap fan at a point
    const addCap = (
      cx: number,
      cy: number,
      z: number,
      startAngle: number,
      sweep: number,
    ) => {
      const center = positions.length;
      positions.push([cx, cy]);
      zValues.push(z);
      for (let s = 0; s <= capSteps; s++) {
        const angle = startAngle + (sweep * s) / capSteps;
        const sx = Math.cos(angle) * hw;
        const sy = Math.sin(angle) * hw;
        positions.push([
          cx + tilt.inv00 * sx + tilt.inv01 * sy,
          cy + tilt.inv10 * sx + tilt.inv11 * sy,
        ]);
        zValues.push(z);
        if (s > 0) {
          indices.push(center, center + s, center + s + 1);
        }
      }
    };

    // Start cap: fan from +perp through backward to -perp
    addCap(x1, y1, z1, perpAngle, Math.PI);
    // End cap: fan from +perp through forward to -perp
    addCap(x2, y2, z2, perpAngle, -Math.PI);
  }

  return { positions, zValues, indices, color, alpha };
}

/**
 * Tessellate a polyline with per-vertex z and constant screen-space width.
 * Screen-width variant of tessellatePolylineToStrip for cylindrical geometry.
 */
export function tessellateScreenWidthPolyline(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: number[],
  width: number,
  tilt: TiltProjection,
  color: number,
  alpha: number = 1,
  closed: boolean = false,
  roundCaps: boolean = false,
): MeshContribution {
  if (points.length < 2) {
    return { positions: [], zValues: [], indices: [], color, alpha };
  }

  const halfWidth = width / 2;
  const positions: [number, number][] = [];
  const zValues: number[] = [];
  const indices: number[] = [];

  // Compute unit screen-space perpendicular for a hull-local segment
  const screenPerpDir = (
    dx: number,
    dy: number,
    dz: number,
  ): [number, number] => {
    const sx = tilt.m00 * dx + tilt.m01 * dy + tilt.zx * dz;
    const sy = tilt.m10 * dx + tilt.m11 * dy + tilt.zy * dz;
    const len = Math.sqrt(sx * sx + sy * sy);
    if (len === 0) return [0, 0];
    return [-sy / len, sx / len];
  };

  // Inverse-project a screen-space offset to hull-local
  const toLocal = (sx: number, sy: number): [number, number] => [
    tilt.inv00 * sx + tilt.inv01 * sy,
    tilt.inv10 * sx + tilt.inv11 * sy,
  ];

  // Emit a vertex pair offset from a point along a screen-space direction
  const emitPair = (
    cx: number,
    cy: number,
    z: number,
    sx: number,
    sy: number,
  ) => {
    const [lx, ly] = toLocal(sx, sy);
    positions.push(
      [cx + lx * halfWidth, cy + ly * halfWidth],
      [cx - lx * halfWidth, cy - ly * halfWidth],
    );
    zValues.push(z, z);
  };

  // Track the base index of the last pair emitted for segment connections.
  let prevPairEnd = -1;
  let firstPairStart = 0;

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const currZ = zPerPoint[i];
    let prev: readonly [number, number] | null = null;
    let prevZ = currZ;
    let next: readonly [number, number] | null = null;
    let nextZ = currZ;

    if (i > 0) {
      prev = points[i - 1];
      prevZ = zPerPoint[i - 1];
    } else if (closed) {
      prev = points[points.length - 1];
      prevZ = zPerPoint[points.length - 1];
    }

    if (i < points.length - 1) {
      next = points[i + 1];
      nextZ = zPerPoint[i + 1];
    } else if (closed) {
      next = points[0];
      nextZ = zPerPoint[0];
    }

    const pairStart = positions.length;
    if (i === 0) firstPairStart = pairStart;

    if (prev === null && next !== null) {
      const [sx, sy] = screenPerpDir(
        next[0] - curr[0],
        next[1] - curr[1],
        nextZ - currZ,
      );
      emitPair(curr[0], curr[1], currZ, sx, sy);
    } else if (next === null && prev !== null) {
      const [sx, sy] = screenPerpDir(
        curr[0] - prev[0],
        curr[1] - prev[1],
        currZ - prevZ,
      );
      emitPair(curr[0], curr[1], currZ, sx, sy);
    } else if (prev !== null && next !== null) {
      const [s1x, s1y] = screenPerpDir(
        curr[0] - prev[0],
        curr[1] - prev[1],
        currZ - prevZ,
      );
      const [s2x, s2y] = screenPerpDir(
        next[0] - curr[0],
        next[1] - curr[1],
        nextZ - currZ,
      );

      // Check if the miter would need clamping
      let mx = (s1x + s2x) / 2;
      let my = (s1y + s2y) / 2;
      const mLen = Math.sqrt(mx * mx + my * my);
      const dot = mLen > 0.001 ? s1x * mx + s1y * my : 0;
      const miterScale = dot > 0.1 ? 1 / dot : 10;

      if (miterScale > 1.05) {
        // Round join: fan from incoming to outgoing perpendicular
        const angle1 = Math.atan2(s1y, s1x);
        let angle2 = Math.atan2(s2y, s2x);
        let angleDiff = angle2 - angle1;
        if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        const steps = Math.max(
          2,
          Math.ceil(Math.abs(angleDiff) / (Math.PI / 8)),
        );
        for (let s = 0; s <= steps; s++) {
          const angle = angle1 + angleDiff * (s / steps);
          emitPair(curr[0], curr[1], currZ, Math.cos(angle), Math.sin(angle));
        }
      } else {
        // Normal miter
        const clampedScale = Math.min(miterScale, 1);
        emitPair(
          curr[0],
          curr[1],
          currZ,
          (mx / mLen) * clampedScale,
          (my / mLen) * clampedScale,
        );
      }
    } else {
      emitPair(curr[0], curr[1], currZ, 0, 1);
    }

    // Connect consecutive vertex pairs within this vertex (round join fan)
    for (let p = pairStart; p < positions.length - 2; p += 2) {
      indices.push(p, p + 2, p + 3, p, p + 3, p + 1);
    }

    // Connect to previous vertex's last pair
    const pairEnd = positions.length - 2;
    if (prevPairEnd >= 0) {
      indices.push(
        prevPairEnd,
        pairStart,
        pairStart + 1,
        prevPairEnd,
        pairStart + 1,
        prevPairEnd + 1,
      );
    }
    prevPairEnd = pairEnd;
  }

  if (closed && points.length >= 3 && prevPairEnd >= 0) {
    indices.push(
      prevPairEnd,
      firstPairStart,
      firstPairStart + 1,
      prevPairEnd,
      firstPairStart + 1,
      prevPairEnd + 1,
    );
  }

  // Round end caps for open polylines
  if (roundCaps && !closed && points.length >= 2) {
    const capSteps = 8;
    const addCap = (
      cx: number,
      cy: number,
      z: number,
      perpSx: number,
      perpSy: number,
      sweep: number,
    ) => {
      const perpAngle = Math.atan2(perpSy, perpSx);
      const center = positions.length;
      positions.push([cx, cy]);
      zValues.push(z);
      for (let s = 0; s <= capSteps; s++) {
        const angle = perpAngle + (sweep * s) / capSteps;
        const sx = Math.cos(angle);
        const sy = Math.sin(angle);
        const [lx, ly] = toLocal(sx, sy);
        positions.push([cx + lx * halfWidth, cy + ly * halfWidth]);
        zValues.push(z);
        if (s > 0) {
          indices.push(center, center + s, center + s + 1);
        }
      }
    };

    // Start cap: perpendicular of first segment, fanning through backward
    const p0 = points[0];
    const p1 = points[1];
    const [sp0x, sp0y] = screenPerpDir(
      p1[0] - p0[0],
      p1[1] - p0[1],
      zPerPoint[1] - zPerPoint[0],
    );
    addCap(p0[0], p0[1], zPerPoint[0], sp0x, sp0y, Math.PI);

    // End cap: perpendicular of last segment, fanning through forward
    const pLast = points[points.length - 1];
    const pPrev = points[points.length - 2];
    const [spLx, spLy] = screenPerpDir(
      pLast[0] - pPrev[0],
      pLast[1] - pPrev[1],
      zPerPoint[points.length - 1] - zPerPoint[points.length - 2],
    );
    addCap(
      pLast[0],
      pLast[1],
      zPerPoint[points.length - 1],
      spLx,
      spLy,
      -Math.PI,
    );
  }

  return { positions, zValues, indices, color, alpha };
}

/**
 * Tessellate a rectangle into 2 triangles at uniform z.
 * Rectangle is axis-aligned in hull-local space.
 */
export function tessellateRectToTris(
  x: number,
  y: number,
  w: number,
  h: number,
  z: number,
  color: number,
  alpha: number = 1,
): MeshContribution {
  return {
    positions: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    zValues: [z, z, z, z],
    indices: [0, 1, 2, 0, 2, 3],
    color,
    alpha,
  };
}

/**
 * Tessellate a rotated rectangle into 2 triangles at uniform z.
 * The rectangle is rotated around (cx, cy) by angle.
 */
export function tessellateRotatedRectToTris(
  cx: number,
  cy: number,
  offsetX: number,
  offsetY: number,
  w: number,
  h: number,
  angle: number,
  z: number,
  color: number,
  alpha: number = 1,
): MeshContribution {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Rectangle corners relative to rotation center, then offset
  const corners: [number, number][] = [
    [offsetX, offsetY],
    [offsetX + w, offsetY],
    [offsetX + w, offsetY + h],
    [offsetX, offsetY + h],
  ];

  const positions: [number, number][] = corners.map(([lx, ly]) => [
    cx + cos * lx - sin * ly,
    cy + sin * lx + cos * ly,
  ]);

  return {
    positions,
    zValues: [z, z, z, z],
    indices: [0, 1, 2, 0, 2, 3],
    color,
    alpha,
  };
}

/**
 * Tessellate a filled circle into a triangle fan with uniform z.
 */
export function tessellateCircleToTris(
  cx: number,
  cy: number,
  z: number,
  radius: number,
  segments: number,
  color: number,
  alpha: number = 1,
): MeshContribution {
  const positions: [number, number][] = [[cx, cy]];
  const zValues: number[] = [z];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
    zValues.push(z);
  }

  for (let i = 1; i <= segments; i++) {
    indices.push(0, i, i + 1 > segments ? 1 : i + 1);
  }

  return { positions, zValues, indices, color, alpha };
}

/**
 * Tessellate a filled circle that maintains a circular screen-space shape
 * regardless of tilt. Offsets are computed in screen space then inverse-
 * projected to hull-local so the GPU tilt transform produces a true circle.
 */
export function tessellateScreenCircle(
  cx: number,
  cy: number,
  z: number,
  radius: number,
  segments: number,
  tilt: TiltProjection,
  color: number,
  alpha: number = 1,
): MeshContribution {
  const positions: [number, number][] = [[cx, cy]];
  const zValues: number[] = [z];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    // Screen-space offset
    const sx = Math.cos(a) * radius;
    const sy = Math.sin(a) * radius;
    // Inverse-project to hull-local
    const lx = tilt.inv00 * sx + tilt.inv01 * sy;
    const ly = tilt.inv10 * sx + tilt.inv11 * sy;
    positions.push([cx + lx, cy + ly]);
    zValues.push(z);
  }

  for (let i = 1; i <= segments; i++) {
    indices.push(0, i, i + 1 > segments ? 1 : i + 1);
  }

  return { positions, zValues, indices, color, alpha };
}

/**
 * Tessellate a polyline with per-vertex z into a triangle strip.
 * Supports miter joins (default) or round joins at corners.
 */
export function tessellatePolylineToStrip(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: number[],
  width: number,
  color: number,
  alpha: number = 1,
  closed: boolean = false,
  roundJoins: boolean = false,
): MeshContribution {
  if (points.length < 2) {
    return { positions: [], zValues: [], indices: [], color, alpha };
  }

  const halfWidth = width / 2;
  const positions: [number, number][] = [];
  const zValues: number[] = [];
  const indices: number[] = [];

  const perp = (dx: number, dy: number): [number, number] => {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return [0, 0];
    return [-dy / len, dx / len];
  };

  const emitPair = (
    cx: number,
    cy: number,
    z: number,
    nx: number,
    ny: number,
  ) => {
    positions.push(
      [cx + nx * halfWidth, cy + ny * halfWidth],
      [cx - nx * halfWidth, cy - ny * halfWidth],
    );
    zValues.push(z, z);
  };

  let prevPairEnd = -1;
  let firstPairStart = 0;

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    let prev: readonly [number, number] | null = null;
    let next: readonly [number, number] | null = null;

    if (i > 0) prev = points[i - 1];
    else if (closed) prev = points[points.length - 1];

    if (i < points.length - 1) next = points[i + 1];
    else if (closed) next = points[0];

    const z = zPerPoint[i];
    const pairStart = positions.length;
    if (i === 0) firstPairStart = pairStart;

    if (prev === null && next !== null) {
      const [nx, ny] = perp(next[0] - curr[0], next[1] - curr[1]);
      emitPair(curr[0], curr[1], z, nx, ny);
    } else if (next === null && prev !== null) {
      const [nx, ny] = perp(curr[0] - prev[0], curr[1] - prev[1]);
      emitPair(curr[0], curr[1], z, nx, ny);
    } else if (prev !== null && next !== null) {
      const [n1x, n1y] = perp(curr[0] - prev[0], curr[1] - prev[1]);
      const [n2x, n2y] = perp(next[0] - curr[0], next[1] - curr[1]);
      let mx = (n1x + n2x) / 2;
      let my = (n1y + n2y) / 2;
      const mLen = Math.sqrt(mx * mx + my * my);
      const dot = mLen > 0.001 ? n1x * mx + n1y * my : 0;
      const miterScale = dot > 0.1 ? 1 / dot : 10;

      if (roundJoins && miterScale > 1.05) {
        // Round join: fan from incoming to outgoing perpendicular
        const angle1 = Math.atan2(n1y, n1x);
        let angle2 = Math.atan2(n2y, n2x);
        let angleDiff = angle2 - angle1;
        if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        const steps = Math.max(
          2,
          Math.ceil(Math.abs(angleDiff) / (Math.PI / 8)),
        );
        for (let s = 0; s <= steps; s++) {
          const angle = angle1 + angleDiff * (s / steps);
          emitPair(curr[0], curr[1], z, Math.cos(angle), Math.sin(angle));
        }
      } else {
        // Miter join
        if (mLen > 0.001) {
          const clampedScale = Math.min(miterScale, 1);
          mx = (mx / mLen) * clampedScale;
          my = (my / mLen) * clampedScale;
        } else {
          mx = n1x;
          my = n1y;
        }
        emitPair(curr[0], curr[1], z, mx, my);
      }
    } else {
      emitPair(curr[0], curr[1], z, 0, 1);
    }

    // Connect consecutive vertex pairs within this vertex (round join fan)
    for (let p = pairStart; p < positions.length - 2; p += 2) {
      indices.push(p, p + 2, p + 3, p, p + 3, p + 1);
    }

    // Connect to previous vertex's last pair
    const pairEnd = positions.length - 2;
    if (prevPairEnd >= 0) {
      indices.push(
        prevPairEnd,
        pairStart,
        pairStart + 1,
        prevPairEnd,
        pairStart + 1,
        prevPairEnd + 1,
      );
    }
    prevPairEnd = pairEnd;
  }

  // Close the strip if needed
  if (closed && points.length >= 3 && prevPairEnd >= 0) {
    indices.push(
      prevPairEnd,
      firstPairStart,
      firstPairStart + 1,
      prevPairEnd,
      firstPairStart + 1,
      prevPairEnd + 1,
    );
  }

  return { positions, zValues, indices, color, alpha };
}

// ============================================================
// Rope-specific tessellation with per-vertex UVs
// ============================================================

/** Result metadata from tessellateRopeStrip (data is in the pre-allocated arrays). */
export interface RopeMeshData {
  vertexCount: number;
  indexCount: number;
}

/** Floats per vertex in the rope shader layout: posX, posY, u, v, z */
export const ROPE_VERTEX_FLOATS = 5;

/**
 * Camera 2x2 transform for screen-space perpendicular computation.
 * Forward: world direction → screen direction.
 * Inverse: screen direction → world direction.
 */
export interface CameraTransform2x2 {
  fa: number;
  fb: number;
  fc: number;
  fd: number;
  ia: number;
  ib: number;
  ic: number;
  id: number;
}

/**
 * Extract the 2x2 forward and inverse parts from a Matrix3 camera transform.
 * The Matrix3 uses column-major [a,b] [c,d] [tx,ty] convention.
 */
export function extractCameraTransform(cam: {
  a: number;
  b: number;
  c: number;
  d: number;
}): CameraTransform2x2 {
  const { a, b, c, d } = cam;
  const det = a * d - b * c;
  const invDet = det !== 0 ? 1 / det : 0;
  return {
    fa: a,
    fb: b,
    fc: c,
    fd: d,
    ia: d * invDet,
    ib: -b * invDet,
    ic: -c * invDet,
    id: a * invDet,
  };
}

/**
 * Tessellate a polyline into a triangle strip with per-vertex UV coordinates
 * for the procedural rope shader.
 *
 * Vertex layout per vertex: [posX, posY, u, v, z] — 5 floats, 20 bytes.
 *   u: cross-rope coordinate, -1 (left edge) to +1 (right edge)
 *   v: cumulative arc length along the centerline (feet)
 *
 * Perpendicular offsets are computed in screen space (via the camera transform)
 * so the rope always appears as a consistent width on screen.
 *
 * Uses simple miter joins. Writes directly into pre-allocated output arrays.
 * Vertex count = 2 * points.length, index count = 6 * (points.length - 1).
 */
export function tessellateRopeStrip(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: ReadonlyArray<number>,
  width: number,
  cam: CameraTransform2x2,
  outVertices: Float32Array,
  outIndices: Uint16Array,
  /** Number of points to use. Defaults to points.length. */
  count?: number,
  /** World-space z gradient (dz/dx, dz/dy). When provided, z varies across
   *  the strip width to match a tilted surface (e.g. a heeled deck). */
  zSlope?: { dx: number; dy: number },
  /** Pre-computed material v-coordinate per point. When provided, the texture
   *  is pinned to the rope material instead of sliding with arc length. */
  vPerPoint?: ReadonlyArray<number>,
): RopeMeshData {
  const n = count ?? points.length;
  if (n < 2) return { vertexCount: 0, indexCount: 0 };

  const halfWidth = width / 2;
  let vOff = 0; // vertex float offset
  let iOff = 0; // index offset
  let cumulativeDist = 0;

  // Compute the perpendicular direction for a world-space segment.
  // The direction is determined in screen space (so the rope faces the
  // camera), then inverse-projected and re-normalized to unit length
  // in world space (so halfWidth stays in world units, not pixels).
  const screenPerp = (dx: number, dy: number): [number, number] => {
    // Forward-project direction to screen
    const sx = cam.fa * dx + cam.fc * dy;
    const sy = cam.fb * dx + cam.fd * dy;
    const sLen = Math.sqrt(sx * sx + sy * sy);
    if (sLen < 1e-6) return [0, 0];
    // Screen-space perpendicular (unit in screen space)
    const px = -sy / sLen;
    const py = sx / sLen;
    // Inverse-project back to world
    const wx = cam.ia * px + cam.ic * py;
    const wy = cam.ib * px + cam.id * py;
    // Re-normalize to unit length in WORLD space
    const wLen = Math.sqrt(wx * wx + wy * wy);
    if (wLen < 1e-6) return [0, 0];
    return [wx / wLen, wy / wLen];
  };

  for (let i = 0; i < n; i++) {
    const cx = points[i][0];
    const cy = points[i][1];
    const z = zPerPoint[i];

    // Accumulate distance along the centerline (fallback when no material v)
    if (!vPerPoint && i > 0) {
      const dx = cx - points[i - 1][0];
      const dy = cy - points[i - 1][1];
      cumulativeDist += Math.sqrt(dx * dx + dy * dy);
    }
    const vCoord = vPerPoint ? vPerPoint[i] : cumulativeDist;

    // Compute perpendicular direction in screen space
    let nx: number, ny: number;
    if (i === 0) {
      [nx, ny] = screenPerp(points[1][0] - cx, points[1][1] - cy);
    } else if (i === n - 1) {
      [nx, ny] = screenPerp(cx - points[i - 1][0], cy - points[i - 1][1]);
    } else {
      // Interior: average screen perpendiculars (miter)
      const [s1x, s1y] = screenPerp(
        cx - points[i - 1][0],
        cy - points[i - 1][1],
      );
      const [s2x, s2y] = screenPerp(
        points[i + 1][0] - cx,
        points[i + 1][1] - cy,
      );
      let mx = (s1x + s2x) / 2;
      let my = (s1y + s2y) / 2;
      const mLen = Math.sqrt(mx * mx + my * my);
      if (mLen > 0.001) {
        const dot = s1x * mx + s1y * my;
        const miterScale = Math.min(dot > 0.1 ? 1 / dot : 1, 1);
        mx = (mx / mLen) * miterScale;
        my = (my / mLen) * miterScale;
      } else {
        mx = s1x;
        my = s1y;
      }
      nx = mx;
      ny = my;
    }

    // Per-vertex z offset from the center z, accounting for deck tilt.
    // On a heeled surface, the left and right edges of the strip sit at
    // different heights — without this, one edge clips through the deck.
    const offX = nx * halfWidth;
    const offY = ny * halfWidth;
    const dz = zSlope ? zSlope.dx * offX + zSlope.dy * offY : 0;

    // Left vertex: u = +1
    outVertices[vOff++] = cx + offX;
    outVertices[vOff++] = cy + offY;
    outVertices[vOff++] = 1; // u
    outVertices[vOff++] = vCoord; // v
    outVertices[vOff++] = z + dz;

    // Right vertex: u = -1
    outVertices[vOff++] = cx - offX;
    outVertices[vOff++] = cy - offY;
    outVertices[vOff++] = -1; // u
    outVertices[vOff++] = vCoord; // v
    outVertices[vOff++] = z - dz;

    // Indices: connect to previous pair
    if (i > 0) {
      const base = (i - 1) * 2;
      outIndices[iOff++] = base;
      outIndices[iOff++] = base + 2;
      outIndices[iOff++] = base + 3;
      outIndices[iOff++] = base;
      outIndices[iOff++] = base + 3;
      outIndices[iOff++] = base + 1;
    }
  }

  return { vertexCount: n * 2, indexCount: (n - 1) * 6 };
}
