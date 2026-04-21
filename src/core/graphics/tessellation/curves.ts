/**
 * Pure geometry helpers: corner rounding and curve subdivision.
 *
 * These functions operate on point/z arrays — no VertexSink involvement.
 * They're used as inputs to the polygon/polyline/spline tessellators.
 */

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

  out.push([points[0][0], points[0][1]]);
  outZ.push(zPerPoint[0]);

  for (let i = 1; i < n - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

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

    const r = Math.min(radius, lenIn * 0.5, lenOut * 0.5);

    const ax = curr[0] - (dix / lenIn) * r;
    const ay = curr[1] - (diy / lenIn) * r;
    const aZ = zPerPoint[i] - (zPerPoint[i] - zPerPoint[i - 1]) * (r / lenIn);

    const bx = curr[0] + (dox / lenOut) * r;
    const by = curr[1] + (doy / lenOut) * r;
    const bZ = zPerPoint[i] + (zPerPoint[i + 1] - zPerPoint[i]) * (r / lenOut);

    arcMidpoints.push({
      x: 0.25 * ax + 0.5 * curr[0] + 0.25 * bx,
      y: 0.25 * ay + 0.5 * curr[1] + 0.25 * by,
      z: 0.25 * aZ + 0.5 * zPerPoint[i] + 0.25 * bZ,
    });

    const dot = (dix / lenIn) * (dox / lenOut) + (diy / lenIn) * (doy / lenOut);
    const turnAmount = (1 - dot) / 2;
    const samples = Math.max(2, Math.round(arcPoints * turnAmount));

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

  out.push([points[0][0], points[0][1]]);
  outZ.push(zPerPoint[0]);

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

  outPoints[idx][0] = points[0][0];
  outPoints[idx][1] = points[0][1];
  outZ[idx] = zPerPoint[0];
  if (vPerPoint && outV) outV[idx] = vPerPoint[0];
  idx++;

  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = i;
    const i2 = i + 1;
    const i3 = Math.min(n - 1, i + 2);

    const p0x = points[i0][0];
    const p0y = points[i0][1];
    const p0z = zPerPoint[i0];
    const p1x = points[i1][0];
    const p1y = points[i1][1];
    const p1z = zPerPoint[i1];
    const p2x = points[i2][0];
    const p2y = points[i2][1];
    const p2z = zPerPoint[i2];
    const p3x = points[i3][0];
    const p3y = points[i3][1];
    const p3z = zPerPoint[i3];

    const v1 = vPerPoint ? vPerPoint[i1] : 0;
    const v2 = vPerPoint ? vPerPoint[i2] : 0;

    for (let s = 1; s <= subdivisions; s++) {
      const t = s / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;

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
