import type { TiltProjection } from "../TiltProjection";
import { unpackColor } from "./color";
import { VertexSink, writeVertex } from "./VertexSink";

export interface PolylineOptions {
  /** If true, join the last vertex to the first. Default false. */
  closed?: boolean;
  /** If true, use round joins at corners where miter would spike. Default false. */
  roundJoins?: boolean;
  /** If true, add semicircular end caps (open polylines only). Default false. */
  roundCaps?: boolean;
}

/**
 * Tessellate a world-width polyline into a triangle strip with optional
 * miter / round joins and round end caps.
 *
 * `zPerPoint` may be either a single number (uniform z) or a per-point array.
 */
export function tessellateWorldPolyline(
  sink: VertexSink,
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: number | ReadonlyArray<number>,
  width: number,
  color: number,
  alpha: number,
  opts: PolylineOptions = {},
): void {
  const n = points.length;
  if (n < 2) return;

  const { r, g, b, a } = unpackColor(color, alpha);
  const halfWidth = width / 2;
  const closed = opts.closed ?? false;
  const roundJoins = opts.roundJoins ?? false;
  const roundCaps = opts.roundCaps ?? false;
  const zAt =
    typeof zPerPoint === "number"
      ? (_: number) => zPerPoint
      : (i: number) => zPerPoint[i];

  // Phase 1: compute offset vertex pairs (and optional round-join fans).
  // This mirrors the old tessellatePolylineToStrip logic but writes directly
  // via VertexSink. We do two passes: first gather vertex data into small
  // arrays, then reserve and write it in one shot per primitive.
  const emits: Array<{
    cx: number;
    cy: number;
    z: number;
    nx: number;
    ny: number;
  }> = [];
  const pairStartForPoint: number[] = [];

  const perp = (dx: number, dy: number): [number, number] => {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return [0, 0];
    return [-dy / len, dx / len];
  };

  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const z = zAt(i);
    let prev: readonly [number, number] | null = null;
    let next: readonly [number, number] | null = null;
    if (i > 0) prev = points[i - 1];
    else if (closed) prev = points[n - 1];
    if (i < n - 1) next = points[i + 1];
    else if (closed) next = points[0];

    pairStartForPoint.push(emits.length);

    if (prev === null && next !== null) {
      const [nx, ny] = perp(next[0] - curr[0], next[1] - curr[1]);
      emits.push({ cx: curr[0], cy: curr[1], z, nx, ny });
    } else if (next === null && prev !== null) {
      const [nx, ny] = perp(curr[0] - prev[0], curr[1] - prev[1]);
      emits.push({ cx: curr[0], cy: curr[1], z, nx, ny });
    } else if (prev !== null && next !== null) {
      const [n1x, n1y] = perp(curr[0] - prev[0], curr[1] - prev[1]);
      const [n2x, n2y] = perp(next[0] - curr[0], next[1] - curr[1]);
      let mx = (n1x + n2x) / 2;
      let my = (n1y + n2y) / 2;
      const mLen = Math.sqrt(mx * mx + my * my);
      const dot = mLen > 0.001 ? n1x * mx + n1y * my : 0;
      const miterScale = dot > 0.1 ? 1 / dot : 10;

      if (roundJoins && miterScale > 1.05) {
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
          emits.push({
            cx: curr[0],
            cy: curr[1],
            z,
            nx: Math.cos(angle),
            ny: Math.sin(angle),
          });
        }
      } else {
        if (mLen > 0.001) {
          const clampedScale = Math.min(miterScale, 1);
          mx = (mx / mLen) * clampedScale;
          my = (my / mLen) * clampedScale;
        } else {
          mx = n1x;
          my = n1y;
        }
        emits.push({ cx: curr[0], cy: curr[1], z, nx: mx, ny: my });
      }
    } else {
      emits.push({ cx: curr[0], cy: curr[1], z, nx: 0, ny: 1 });
    }
  }
  pairStartForPoint.push(emits.length);

  // Phase 2: compute end-cap extras if requested.
  interface CapData {
    // cx, cy, z, then (capSteps+1) rim offsets (cos,sin)
    cx: number;
    cy: number;
    z: number;
    perpAngle: number;
    sweep: number;
    capSteps: number;
  }
  const caps: CapData[] = [];
  const capSteps = 8;
  if (roundCaps && !closed && n >= 2) {
    // Start cap: fan perpendicular-of-first-segment, sweeping backward.
    const p0 = points[0];
    const p1 = points[1];
    const [sp0x, sp0y] = perp(p1[0] - p0[0], p1[1] - p0[1]);
    caps.push({
      cx: p0[0],
      cy: p0[1],
      z: zAt(0),
      perpAngle: Math.atan2(sp0y, sp0x),
      sweep: Math.PI,
      capSteps,
    });
    const pLast = points[n - 1];
    const pPrev = points[n - 2];
    const [spLx, spLy] = perp(pLast[0] - pPrev[0], pLast[1] - pPrev[1]);
    caps.push({
      cx: pLast[0],
      cy: pLast[1],
      z: zAt(n - 1),
      perpAngle: Math.atan2(spLy, spLx),
      sweep: -Math.PI,
      capSteps,
    });
  }

  // Compute index count:
  //   For each strip segment between two vertex groups: (vertsInGroup_prev-1) * 6
  //   Plus within-group fans: (vertsInGroup - 1) * 6 where vertsInGroup > 1 (round-join)
  //   Plus cap fans: capSteps * 3 each
  let totalVerts = emits.length * 2;
  let totalIndices = 0;
  for (let i = 0; i < n; i++) {
    const pairStart = pairStartForPoint[i];
    const pairEnd = pairStartForPoint[i + 1];
    const pairsHere = pairEnd - pairStart;
    if (pairsHere > 1) {
      totalIndices += (pairsHere - 1) * 6;
    }
  }
  const segmentConnections = closed ? n : n - 1;
  totalIndices += segmentConnections * 6;
  for (const cap of caps) {
    totalVerts += cap.capSteps + 2; // center + (capSteps+1) rim
    totalIndices += cap.capSteps * 3;
  }

  const { base, view } = sink.reserveVertices(totalVerts);
  const idxData = sink.reserveIndices(totalIndices);

  // Write offset pairs.
  for (let e = 0; e < emits.length; e++) {
    const { cx, cy, z, nx, ny } = emits[e];
    writeVertex(
      view,
      e * 2,
      cx + nx * halfWidth,
      cy + ny * halfWidth,
      r,
      g,
      b,
      a,
      z,
    );
    writeVertex(
      view,
      e * 2 + 1,
      cx - nx * halfWidth,
      cy - ny * halfWidth,
      r,
      g,
      b,
      a,
      z,
    );
  }

  // Build index list.
  let iOut = 0;
  // Within-vertex fans (round joins produce multiple pairs per vertex).
  for (let i = 0; i < n; i++) {
    const pairStart = pairStartForPoint[i];
    const pairEnd = pairStartForPoint[i + 1];
    for (let p = pairStart; p < pairEnd - 1; p++) {
      const p0 = base + p * 2;
      const p1 = base + p * 2 + 1;
      const p2 = base + (p + 1) * 2;
      const p3 = base + (p + 1) * 2 + 1;
      idxData[iOut++] = p0;
      idxData[iOut++] = p2;
      idxData[iOut++] = p3;
      idxData[iOut++] = p0;
      idxData[iOut++] = p3;
      idxData[iOut++] = p1;
    }
  }
  // Between-vertex strip connections.
  for (let i = 0; i < segmentConnections; i++) {
    const a0 = pairStartForPoint[i + 1] - 1; // last pair of vertex i
    const b0 = pairStartForPoint[closed && i === n - 1 ? 0 : i + 1]; // first pair of vertex i+1 (or 0 when closing)
    const v0 = base + a0 * 2;
    const v1 = base + a0 * 2 + 1;
    const v2 = base + b0 * 2;
    const v3 = base + b0 * 2 + 1;
    idxData[iOut++] = v0;
    idxData[iOut++] = v2;
    idxData[iOut++] = v3;
    idxData[iOut++] = v0;
    idxData[iOut++] = v3;
    idxData[iOut++] = v1;
  }
  // Caps.
  let capVertBase = emits.length * 2;
  for (const cap of caps) {
    const center = base + capVertBase;
    writeVertex(view, capVertBase, cap.cx, cap.cy, r, g, b, a, cap.z);
    for (let s = 0; s <= cap.capSteps; s++) {
      const angle = cap.perpAngle + (cap.sweep * s) / cap.capSteps;
      writeVertex(
        view,
        capVertBase + 1 + s,
        cap.cx + Math.cos(angle) * halfWidth,
        cap.cy + Math.sin(angle) * halfWidth,
        r,
        g,
        b,
        a,
        cap.z,
      );
      if (s > 0) {
        idxData[iOut++] = center;
        idxData[iOut++] = center + s;
        idxData[iOut++] = center + s + 1;
      }
    }
    capVertBase += cap.capSteps + 2;
  }
}

/**
 * Tilt-aware screen-width polyline. Perpendiculars are computed in screen
 * space (for constant on-screen width under tilt) then inverse-projected
 * to local coordinates so the GPU tilt transform cancels out.
 *
 * Requires per-vertex z so parallax is taken into account when projecting.
 */
export function tessellateScreenPolyline(
  sink: VertexSink,
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: ReadonlyArray<number>,
  width: number,
  tilt: TiltProjection,
  color: number,
  alpha: number,
  opts: PolylineOptions = {},
): void {
  const n = points.length;
  if (n < 2) return;

  const { r, g, b, a } = unpackColor(color, alpha);
  const halfWidth = width / 2;
  const closed = opts.closed ?? false;
  const roundJoins = opts.roundJoins ?? false;
  const roundCaps = opts.roundCaps ?? false;

  // Unit screen-space perpendicular for a local segment.
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

  const toLocal = (sx: number, sy: number): [number, number] => [
    tilt.inv00 * sx + tilt.inv01 * sy,
    tilt.inv10 * sx + tilt.inv11 * sy,
  ];

  interface Emit {
    cx: number;
    cy: number;
    z: number;
    sx: number;
    sy: number;
  }
  const emits: Emit[] = [];
  const pairStartForPoint: number[] = [];

  for (let i = 0; i < n; i++) {
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
      prev = points[n - 1];
      prevZ = zPerPoint[n - 1];
    }
    if (i < n - 1) {
      next = points[i + 1];
      nextZ = zPerPoint[i + 1];
    } else if (closed) {
      next = points[0];
      nextZ = zPerPoint[0];
    }

    pairStartForPoint.push(emits.length);

    if (prev === null && next !== null) {
      const [sx, sy] = screenPerpDir(
        next[0] - curr[0],
        next[1] - curr[1],
        nextZ - currZ,
      );
      emits.push({ cx: curr[0], cy: curr[1], z: currZ, sx, sy });
    } else if (next === null && prev !== null) {
      const [sx, sy] = screenPerpDir(
        curr[0] - prev[0],
        curr[1] - prev[1],
        currZ - prevZ,
      );
      emits.push({ cx: curr[0], cy: curr[1], z: currZ, sx, sy });
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
      let mx = (s1x + s2x) / 2;
      let my = (s1y + s2y) / 2;
      const mLen = Math.sqrt(mx * mx + my * my);
      const dot = mLen > 0.001 ? s1x * mx + s1y * my : 0;
      const miterScale = dot > 0.1 ? 1 / dot : 10;
      if (roundJoins && miterScale > 1.05) {
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
          emits.push({
            cx: curr[0],
            cy: curr[1],
            z: currZ,
            sx: Math.cos(angle),
            sy: Math.sin(angle),
          });
        }
      } else {
        if (mLen > 0.001) {
          const clampedScale = Math.min(miterScale, 1);
          mx = (mx / mLen) * clampedScale;
          my = (my / mLen) * clampedScale;
        } else {
          mx = s1x;
          my = s1y;
        }
        emits.push({ cx: curr[0], cy: curr[1], z: currZ, sx: mx, sy: my });
      }
    } else {
      emits.push({ cx: curr[0], cy: curr[1], z: currZ, sx: 0, sy: 1 });
    }
  }
  pairStartForPoint.push(emits.length);

  const capSteps = 8;
  interface Cap {
    cx: number;
    cy: number;
    z: number;
    perpSx: number;
    perpSy: number;
    sweep: number;
  }
  const caps: Cap[] = [];
  if (roundCaps && !closed && n >= 2) {
    const p0 = points[0];
    const p1 = points[1];
    const [sp0x, sp0y] = screenPerpDir(
      p1[0] - p0[0],
      p1[1] - p0[1],
      zPerPoint[1] - zPerPoint[0],
    );
    caps.push({
      cx: p0[0],
      cy: p0[1],
      z: zPerPoint[0],
      perpSx: sp0x,
      perpSy: sp0y,
      sweep: Math.PI,
    });
    const pLast = points[n - 1];
    const pPrev = points[n - 2];
    const [spLx, spLy] = screenPerpDir(
      pLast[0] - pPrev[0],
      pLast[1] - pPrev[1],
      zPerPoint[n - 1] - zPerPoint[n - 2],
    );
    caps.push({
      cx: pLast[0],
      cy: pLast[1],
      z: zPerPoint[n - 1],
      perpSx: spLx,
      perpSy: spLy,
      sweep: -Math.PI,
    });
  }

  let totalVerts = emits.length * 2;
  let totalIndices = 0;
  for (let i = 0; i < n; i++) {
    const pairsHere = pairStartForPoint[i + 1] - pairStartForPoint[i];
    if (pairsHere > 1) totalIndices += (pairsHere - 1) * 6;
  }
  const segmentConnections = closed ? n : n - 1;
  totalIndices += segmentConnections * 6;
  for (const _ of caps) {
    totalVerts += capSteps + 2;
    totalIndices += capSteps * 3;
  }

  const { base, view } = sink.reserveVertices(totalVerts);
  const idxData = sink.reserveIndices(totalIndices);

  for (let e = 0; e < emits.length; e++) {
    const { cx, cy, z, sx, sy } = emits[e];
    const [lx, ly] = toLocal(sx, sy);
    writeVertex(
      view,
      e * 2,
      cx + lx * halfWidth,
      cy + ly * halfWidth,
      r,
      g,
      b,
      a,
      z,
    );
    writeVertex(
      view,
      e * 2 + 1,
      cx - lx * halfWidth,
      cy - ly * halfWidth,
      r,
      g,
      b,
      a,
      z,
    );
  }

  let iOut = 0;
  for (let i = 0; i < n; i++) {
    const pairStart = pairStartForPoint[i];
    const pairEnd = pairStartForPoint[i + 1];
    for (let p = pairStart; p < pairEnd - 1; p++) {
      const p0 = base + p * 2;
      const p1 = base + p * 2 + 1;
      const p2 = base + (p + 1) * 2;
      const p3 = base + (p + 1) * 2 + 1;
      idxData[iOut++] = p0;
      idxData[iOut++] = p2;
      idxData[iOut++] = p3;
      idxData[iOut++] = p0;
      idxData[iOut++] = p3;
      idxData[iOut++] = p1;
    }
  }
  for (let i = 0; i < segmentConnections; i++) {
    const a0 = pairStartForPoint[i + 1] - 1;
    const b0 = pairStartForPoint[closed && i === n - 1 ? 0 : i + 1];
    const v0 = base + a0 * 2;
    const v1 = base + a0 * 2 + 1;
    const v2 = base + b0 * 2;
    const v3 = base + b0 * 2 + 1;
    idxData[iOut++] = v0;
    idxData[iOut++] = v2;
    idxData[iOut++] = v3;
    idxData[iOut++] = v0;
    idxData[iOut++] = v3;
    idxData[iOut++] = v1;
  }
  let capVertBase = emits.length * 2;
  for (const cap of caps) {
    const perpAngle = Math.atan2(cap.perpSy, cap.perpSx);
    const center = base + capVertBase;
    writeVertex(view, capVertBase, cap.cx, cap.cy, r, g, b, a, cap.z);
    for (let s = 0; s <= capSteps; s++) {
      const angle = perpAngle + (cap.sweep * s) / capSteps;
      const sx = Math.cos(angle);
      const sy = Math.sin(angle);
      const [lx, ly] = toLocal(sx, sy);
      writeVertex(
        view,
        capVertBase + 1 + s,
        cap.cx + lx * halfWidth,
        cap.cy + ly * halfWidth,
        r,
        g,
        b,
        a,
        cap.z,
      );
      if (s > 0) {
        idxData[iOut++] = center;
        idxData[iOut++] = center + s;
        idxData[iOut++] = center + s + 1;
      }
    }
    capVertBase += capSteps + 2;
  }
}
