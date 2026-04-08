/**
 * Tessellation utilities for converting 3D boat geometry (lines, polylines,
 * rectangles, circles) into triangle meshes with per-vertex z-values.
 *
 * All functions produce data suitable for WebGPURenderer.submitTrianglesWithZ().
 */

/**
 * Tilt projection parameters, precomputed once per frame.
 * Used by screen-width tessellation functions to compute hull-local offsets
 * that produce constant screen-space width after GPU tilt projection.
 */
export interface TiltProjection {
  /** 2x2 xy-columns of the Yaw·Pitch·Roll rotation matrix */
  m00: number;
  m10: number;
  m01: number;
  m11: number;
  /** z-column: how z-height displaces screen position */
  zx: number;
  zy: number;
  /** Inverse of the 2x2 matrix (for screen→local transform) */
  inv00: number;
  inv10: number;
  inv01: number;
  inv11: number;
}

/**
 * Precompute the tilt projection matrix from hull body state.
 *
 * Returns the 2×2 xy-columns of the Yaw·Pitch·Roll rotation plus the
 * z-column (for parallax) and the 2×2 inverse. Screen-width tessellation
 * uses the forward projection to find the on-screen line direction, then
 * the inverse to convert a screen-space perpendicular offset back to
 * hull-local coordinates. The GPU's model matrix (camera × rotation) and
 * the inverse cancel, leaving only the camera zoom — so line widths scale
 * naturally with zoom but stay constant under tilt.
 */
export function computeTiltProjection(
  angle: number,
  roll: number,
  pitch: number,
): TiltProjection {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const sr = Math.sin(roll);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const cp = Math.cos(pitch);

  const m00 = ca * cp;
  const m10 = sa * cp;
  const m01 = ca * sp * sr - sa * cr;
  const m11 = sa * sp * sr + ca * cr;

  const zx = -(ca * sp * cr + sa * sr);
  const zy = -(sa * sp * cr - ca * sr);

  // Inverse of the 2x2 matrix: (1/det) * [[m11, -m01], [-m10, m00]]
  const det = m00 * m11 - m01 * m10;
  const invDet = det !== 0 ? 1 / det : 1;

  return {
    m00,
    m10,
    m01,
    m11,
    zx,
    zy,
    inv00: m11 * invDet,
    inv10: -m10 * invDet,
    inv01: -m01 * invDet,
    inv11: m00 * invDet,
  };
}

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
 * Subdivide a closed polygon using quadratic bezier smoothing.
 * Every vertex is treated as a control point; on-curve points are placed
 * at midpoints between consecutive controls. This produces a smooth
 * C1-continuous closed curve.
 *
 * Vertices in `sharpIndices` are kept as hard corners — the curve passes
 * through them exactly instead of smoothing around them.
 *
 * Subdivision count is adaptive: sharper corners get more points to stay
 * smooth, while gentle curves use fewer.
 *
 * @param subdivisions Base subdivision count — a 45° bend gets this many points
 * @param sharpIndices Set of vertex indices that should remain sharp corners
 */
export function subdivideClosedSmooth(
  points: ReadonlyArray<readonly [number, number]>,
  subdivisions: number = 4,
  sharpIndices?: ReadonlySet<number>,
): [number, number][] {
  const n = points.length;
  if (n < 3) {
    return points.map((p) => [p[0], p[1]] as [number, number]);
  }

  // Compute on-curve knot for the edge from P[i] to P[next].
  // Sharp vertices pull the knot to themselves.
  const knot = (i: number, next: number): [number, number] => {
    if (sharpIndices?.has(next)) return [points[next][0], points[next][1]];
    if (sharpIndices?.has(i)) return [points[i][0], points[i][1]];
    return [
      (points[i][0] + points[next][0]) / 2,
      (points[i][1] + points[next][1]) / 2,
    ];
  };

  const out: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const next2 = (i + 2) % n;

    // If the control point (P[next]) is sharp, both knots collapse to it —
    // just emit the sharp point and skip the bezier sampling.
    if (sharpIndices?.has(next)) {
      out.push([points[next][0], points[next][1]]);
      continue;
    }

    const [p0x, p0y] = knot(i, next);
    const cpx = points[next][0];
    const cpy = points[next][1];
    const [p1x, p1y] = knot(next, next2);

    // Compute bend angle at control point to scale subdivisions
    const dx0 = p0x - cpx;
    const dy0 = p0y - cpy;
    const dx1 = p1x - cpx;
    const dy1 = p1y - cpy;
    const len0 = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

    let subs = subdivisions;
    if (len0 > 1e-6 && len1 > 1e-6) {
      const cosAngle = (dx0 * dx1 + dy0 * dy1) / (len0 * len1);
      const bend = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosAngle)));
      // Floor at base subdivisions, scale up for sharper bends (30° = base)
      subs = Math.min(
        subdivisions * 3,
        Math.max(
          subdivisions,
          Math.ceil((subdivisions * bend) / (Math.PI / 6)),
        ),
      );
    }

    // Sample quadratic Bezier, skip t=1 (start of next segment).
    // Also skip t=0 if the start knot is a sharp vertex already emitted.
    const startS = sharpIndices?.has(i) ? 1 : 0;
    for (let s = startS; s < subs; s++) {
      const t = s / subs;
      const u = 1 - t;
      out.push([
        u * u * p0x + 2 * u * t * cpx + t * t * p1x,
        u * u * p0y + 2 * u * t * cpy + t * t * p1y,
      ]);
    }
  }

  return out;
}

/**
 * Round the corners of a polyline by inserting bezier arcs at each interior vertex.
 * Straight segments stay straight; only the corners get rounded.
 * The original vertex becomes the bezier control point, with on-curve points
 * offset inward along each adjacent segment by `radius`.
 *
 * @param radius How far from each corner to start rounding (ft)
 * @param arcPoints Number of points to sample along each corner arc (4-8 typical)
 */
export function roundCorners(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: number[],
  radius: number,
  arcPoints: number = 16,
): {
  points: [number, number][];
  zValues: number[];
  /** Arc midpoints for each interior vertex (where the rounded path is closest to the original vertex). */
  arcMidpoints: { x: number; y: number; z: number }[];
} {
  const n = points.length;
  if (n < 3 || radius <= 0) {
    return {
      points: points.map((p) => [p[0], p[1]] as [number, number]),
      zValues: [...zPerPoint],
      arcMidpoints: [],
    };
  }

  const out: [number, number][] = [];
  const outZ: number[] = [];
  const arcMidpoints: { x: number; y: number; z: number }[] = [];

  // First point (no rounding)
  out.push([points[0][0], points[0][1]]);
  outZ.push(zPerPoint[0]);

  for (let i = 1; i < n - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Incoming and outgoing segment vectors
    const dix = curr[0] - prev[0];
    const diy = curr[1] - prev[1];
    const dox = next[0] - curr[0];
    const doy = next[1] - curr[1];
    const lenIn = Math.sqrt(dix * dix + diy * diy);
    const lenOut = Math.sqrt(dox * dox + doy * doy);

    if (lenIn < 1e-6 || lenOut < 1e-6) {
      out.push([curr[0], curr[1]]);
      outZ.push(zPerPoint[i]);
      arcMidpoints.push({ x: curr[0], y: curr[1], z: zPerPoint[i] });
      continue;
    }

    // Clamp radius so we don't overshoot either segment
    const r = Math.min(radius, lenIn * 0.5, lenOut * 0.5);

    // Arc start: back off from vertex along incoming segment
    const ax = curr[0] - (dix / lenIn) * r;
    const ay = curr[1] - (diy / lenIn) * r;
    const aZ = zPerPoint[i] - (zPerPoint[i] - zPerPoint[i - 1]) * (r / lenIn);

    // Arc end: advance from vertex along outgoing segment
    const bx = curr[0] + (dox / lenOut) * r;
    const by = curr[1] + (doy / lenOut) * r;
    const bZ = zPerPoint[i] + (zPerPoint[i + 1] - zPerPoint[i]) * (r / lenOut);

    // Arc midpoint at t=0.5: where the path is closest to the original vertex
    arcMidpoints.push({
      x: 0.25 * ax + 0.5 * curr[0] + 0.25 * bx,
      y: 0.25 * ay + 0.5 * curr[1] + 0.25 * by,
      z: 0.25 * aZ + 0.5 * zPerPoint[i] + 0.25 * bZ,
    });

    // Scale arc samples by how sharp the corner is.
    // dot=1 means straight (no turn), dot=-1 means full U-turn.
    const dot = (dix / lenIn) * (dox / lenOut) + (diy / lenIn) * (doy / lenOut);
    const turnAmount = (1 - dot) / 2; // 0 = straight, 1 = U-turn
    const samples = Math.max(2, Math.round(arcPoints * turnAmount));

    // Sample quadratic bezier: arc_start -> vertex (control) -> arc_end
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const u = 1 - t;
      out.push([
        u * u * ax + 2 * u * t * curr[0] + t * t * bx,
        u * u * ay + 2 * u * t * curr[1] + t * t * by,
      ]);
      outZ.push(u * u * aZ + 2 * u * t * zPerPoint[i] + t * t * bZ);
    }
  }

  // Last point (no rounding)
  out.push([points[n - 1][0], points[n - 1][1]]);
  outZ.push(zPerPoint[n - 1]);

  return { points: out, zValues: outZ, arcMidpoints };
}

/**
 * Subdivide a polyline using quadratic bezier smoothing with per-vertex z.
 * Interior points are treated as control points; on-curve points are placed
 * at midpoints between consecutive control points. This produces a smooth
 * C1-continuous curve through the subdivided points.
 *
 * @param subdivisions Number of interpolated points per segment (2-4 is typical)
 */
export function subdivideSmooth(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: number[],
  subdivisions: number = 3,
): { points: [number, number][]; zValues: number[] } {
  const n = points.length;
  if (n < 3) {
    return {
      points: points.map((p) => [p[0], p[1]] as [number, number]),
      zValues: [...zPerPoint],
    };
  }

  const out: [number, number][] = [];
  const outZ: number[] = [];

  // First point is on the curve
  out.push([points[0][0], points[0][1]]);
  outZ.push(zPerPoint[0]);

  // Interior segments: each pair of control points defines a quadratic bezier
  // where the on-curve knots are midpoints between consecutive control points.
  for (let i = 0; i < n - 2; i++) {
    const p0x = i === 0 ? points[0][0] : (points[i][0] + points[i + 1][0]) / 2;
    const p0y = i === 0 ? points[0][1] : (points[i][1] + points[i + 1][1]) / 2;
    const p0z = i === 0 ? zPerPoint[0] : (zPerPoint[i] + zPerPoint[i + 1]) / 2;

    const cpx = points[i + 1][0];
    const cpy = points[i + 1][1];
    const cpz = zPerPoint[i + 1];

    const p1x =
      i === n - 3
        ? points[n - 1][0]
        : (points[i + 1][0] + points[i + 2][0]) / 2;
    const p1y =
      i === n - 3
        ? points[n - 1][1]
        : (points[i + 1][1] + points[i + 2][1]) / 2;
    const p1z =
      i === n - 3
        ? zPerPoint[n - 1]
        : (zPerPoint[i + 1] + zPerPoint[i + 2]) / 2;

    // Sample the quadratic bezier: B(t) = (1-t)²·p0 + 2(1-t)t·cp + t²·p1
    for (let s = 1; s <= subdivisions; s++) {
      const t = s / subdivisions;
      const u = 1 - t;
      const x = u * u * p0x + 2 * u * t * cpx + t * t * p1x;
      const y = u * u * p0y + 2 * u * t * cpy + t * t * p1y;
      const z = u * u * p0z + 2 * u * t * cpz + t * t * p1z;
      out.push([x, y]);
      outZ.push(z);
    }
  }

  return { points: out, zValues: outZ };
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
 * Subdivide an open polyline using Catmull-Rom interpolation.
 * The output curve passes exactly through all input points.
 * Zero-allocation: writes into pre-allocated output arrays.
 *
 * Output point count = (n - 1) * subdivisions + 1, where n = input point count.
 *
 * @returns The number of output points written.
 */
export function subdivideCatmullRom(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: ReadonlyArray<number>,
  subdivisions: number,
  outPoints: [number, number][],
  outZ: number[],
  /** Optional per-input-point material v-coordinate. When provided, output
   *  v-values are linearly interpolated (not Catmull-Rom — avoids overshoot)
   *  so the texture sticks to the rope material. */
  vPerPoint?: ReadonlyArray<number>,
  outV?: number[],
): number {
  const n = points.length;
  if (n < 2) {
    if (n === 1) {
      outPoints[0][0] = points[0][0];
      outPoints[0][1] = points[0][1];
      outZ[0] = zPerPoint[0];
      if (vPerPoint && outV) outV[0] = vPerPoint[0];
      return 1;
    }
    return 0;
  }

  let idx = 0;

  // Emit the first point
  outPoints[idx][0] = points[0][0];
  outPoints[idx][1] = points[0][1];
  outZ[idx] = zPerPoint[0];
  if (vPerPoint && outV) outV[idx] = vPerPoint[0];
  idx++;

  for (let i = 0; i < n - 1; i++) {
    // Control points: clamp at boundaries
    const i0 = Math.max(0, i - 1);
    const i1 = i;
    const i2 = i + 1;
    const i3 = Math.min(n - 1, i + 2);

    const p0x = points[i0][0],
      p0y = points[i0][1],
      p0z = zPerPoint[i0];
    const p1x = points[i1][0],
      p1y = points[i1][1],
      p1z = zPerPoint[i1];
    const p2x = points[i2][0],
      p2y = points[i2][1],
      p2z = zPerPoint[i2];
    const p3x = points[i3][0],
      p3y = points[i3][1],
      p3z = zPerPoint[i3];

    // Material v: linear interpolation between input points
    const v1 = vPerPoint ? vPerPoint[i1] : 0;
    const v2 = vPerPoint ? vPerPoint[i2] : 0;

    // Emit subdivisions points (skip t=0 since it was the previous segment's end)
    for (let s = 1; s <= subdivisions; s++) {
      const t = s / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom: 0.5 * (2p1 + (-p0+p2)*t + (2p0-5p1+4p2-p3)*t² + (-p0+3p1-3p2+p3)*t³)
      outPoints[idx][0] =
        0.5 *
        (2 * p1x +
          (-p0x + p2x) * t +
          (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 +
          (-p0x + 3 * p1x - 3 * p2x + p3x) * t3);
      outPoints[idx][1] =
        0.5 *
        (2 * p1y +
          (-p0y + p2y) * t +
          (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
          (-p0y + 3 * p1y - 3 * p2y + p3y) * t3);
      outZ[idx] =
        0.5 *
        (2 * p1z +
          (-p0z + p2z) * t +
          (2 * p0z - 5 * p1z + 4 * p2z - p3z) * t2 +
          (-p0z + 3 * p1z - 3 * p2z + p3z) * t3);
      if (outV) outV[idx] = v1 + (v2 - v1) * t;
      idx++;
    }
  }

  return idx;
}

/**
 * Compute the output point count for Catmull-Rom subdivision.
 */
export function catmullRomOutputCount(
  inputPoints: number,
  subdivisions: number,
): number {
  if (inputPoints < 2) return inputPoints;
  return (inputPoints - 1) * subdivisions + 1;
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
