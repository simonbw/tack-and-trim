/**
 * Tessellation utilities for converting 3D boat geometry (lines, polylines,
 * rectangles, circles) into triangle meshes with per-vertex z-values.
 *
 * All functions produce data suitable for WebGPURenderer.submitTrianglesWithZ().
 */

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
 * Tessellate a polyline with per-vertex z into a triangle strip with miter joins.
 * Adapted from PathBuilder.stroke() logic.
 */
export function tessellatePolylineToStrip(
  points: ReadonlyArray<readonly [number, number]>,
  zPerPoint: number[],
  width: number,
  color: number,
  alpha: number = 1,
  closed: boolean = false,
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

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    let prev: readonly [number, number] | null = null;
    let next: readonly [number, number] | null = null;

    if (i > 0) prev = points[i - 1];
    else if (closed) prev = points[points.length - 1];

    if (i < points.length - 1) next = points[i + 1];
    else if (closed) next = points[0];

    let nx: number, ny: number;

    if (prev === null && next !== null) {
      [nx, ny] = perp(next[0] - curr[0], next[1] - curr[1]);
    } else if (next === null && prev !== null) {
      [nx, ny] = perp(curr[0] - prev[0], curr[1] - prev[1]);
    } else if (prev !== null && next !== null) {
      const [n1x, n1y] = perp(curr[0] - prev[0], curr[1] - prev[1]);
      const [n2x, n2y] = perp(next[0] - curr[0], next[1] - curr[1]);
      let mx = (n1x + n2x) / 2;
      let my = (n1y + n2y) / 2;
      const mLen = Math.sqrt(mx * mx + my * my);
      if (mLen > 0.001) {
        // Miter: scale so that the offset at the join is correct
        const dot = n1x * mx + n1y * my;
        const scale = dot > 0.1 ? 1 / dot : 1;
        // Clamp miter to avoid spikes at sharp angles
        const clampedScale = Math.min(scale, 3);
        mx = (mx / mLen) * clampedScale;
        my = (my / mLen) * clampedScale;
      } else {
        mx = n1x;
        my = n1y;
      }
      nx = mx;
      ny = my;
    } else {
      nx = 0;
      ny = 1;
    }

    const z = zPerPoint[i];
    // Left and right offset vertices
    positions.push(
      [curr[0] + nx * halfWidth, curr[1] + ny * halfWidth],
      [curr[0] - nx * halfWidth, curr[1] - ny * halfWidth],
    );
    zValues.push(z, z);

    // Build quad between this point and the previous
    if (i > 0) {
      const base = (i - 1) * 2;
      indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
    }
  }

  // Close the strip if needed
  if (closed && points.length >= 3) {
    const last = (points.length - 1) * 2;
    indices.push(last, 0, 1, last, 1, last + 1);
  }

  return { positions, zValues, indices, color, alpha };
}
