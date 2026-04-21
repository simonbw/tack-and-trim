import type { TiltProjection } from "../TiltProjection";
import { unpackColor } from "./color";
import { VertexSink, writeVertex } from "./VertexSink";

/**
 * World-width line as a 2-triangle quad. Perpendicular is taken in local XY.
 */
export function tessellateLine(
  sink: VertexSink,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: number,
  alpha: number,
  z: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const hw = width / 2;
  const nx = (-dy / len) * hw;
  const ny = (dx / len) * hw;

  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(4);
  writeVertex(view, 0, x1 + nx, y1 + ny, r, g, b, a, z);
  writeVertex(view, 1, x2 + nx, y2 + ny, r, g, b, a, z);
  writeVertex(view, 2, x2 - nx, y2 - ny, r, g, b, a, z);
  writeVertex(view, 3, x1 - nx, y1 - ny, r, g, b, a, z);

  const idx = sink.reserveIndices(6);
  idx[0] = base;
  idx[1] = base + 1;
  idx[2] = base + 2;
  idx[3] = base;
  idx[4] = base + 2;
  idx[5] = base + 3;
}

/**
 * Tilt-aware screen-width line. The perpendicular is computed in screen
 * space (using the tilt projection) then inverse-transformed back to local
 * space so the GPU tilt transform produces the desired constant on-screen
 * width regardless of roll/pitch.
 *
 * Supports per-endpoint z, and optionally semicircular round end caps.
 */
export function tessellateScreenLine(
  sink: VertexSink,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
  width: number,
  tilt: TiltProjection,
  color: number,
  alpha: number,
  roundCaps: boolean = false,
): void {
  const dlx = x2 - x1;
  const dly = y2 - y1;
  const dlz = z2 - z1;
  const dsx = tilt.m00 * dlx + tilt.m01 * dly + tilt.zx * dlz;
  const dsy = tilt.m10 * dlx + tilt.m11 * dly + tilt.zy * dlz;
  const sLen = Math.sqrt(dsx * dsx + dsy * dsy);
  if (sLen < 1e-6) return;

  const hw = width / 2;
  const spx = (-dsy / sLen) * hw;
  const spy = (dsx / sLen) * hw;
  const nx = tilt.inv00 * spx + tilt.inv01 * spy;
  const ny = tilt.inv10 * spx + tilt.inv11 * spy;

  const { r, g, b, a } = unpackColor(color, alpha);

  if (!roundCaps) {
    const { base, view } = sink.reserveVertices(4);
    writeVertex(view, 0, x1 + nx, y1 + ny, r, g, b, a, z1);
    writeVertex(view, 1, x2 + nx, y2 + ny, r, g, b, a, z2);
    writeVertex(view, 2, x2 - nx, y2 - ny, r, g, b, a, z2);
    writeVertex(view, 3, x1 - nx, y1 - ny, r, g, b, a, z1);
    const idx = sink.reserveIndices(6);
    idx[0] = base;
    idx[1] = base + 1;
    idx[2] = base + 2;
    idx[3] = base;
    idx[4] = base + 2;
    idx[5] = base + 3;
    return;
  }

  // With round caps: main quad (4 verts) + start cap (1 center + 9 rim) + end cap (1 + 9)
  const capSteps = 8;
  const vertsPerCap = capSteps + 2; // center + (capSteps + 1) rim
  const totalVerts = 4 + vertsPerCap * 2;
  const totalIdx = 6 + capSteps * 3 * 2;
  const { base, view } = sink.reserveVertices(totalVerts);

  writeVertex(view, 0, x1 + nx, y1 + ny, r, g, b, a, z1);
  writeVertex(view, 1, x2 + nx, y2 + ny, r, g, b, a, z2);
  writeVertex(view, 2, x2 - nx, y2 - ny, r, g, b, a, z2);
  writeVertex(view, 3, x1 - nx, y1 - ny, r, g, b, a, z1);

  const idx = sink.reserveIndices(totalIdx);
  idx[0] = base;
  idx[1] = base + 1;
  idx[2] = base + 2;
  idx[3] = base;
  idx[4] = base + 2;
  idx[5] = base + 3;

  const perpAngle = Math.atan2(spy, spx);
  const writeCap = (
    vStart: number,
    iStart: number,
    cx: number,
    cy: number,
    cz: number,
    sweep: number,
  ) => {
    const center = base + vStart;
    writeVertex(view, vStart, cx, cy, r, g, b, a, cz);
    for (let s = 0; s <= capSteps; s++) {
      const angle = perpAngle + (sweep * s) / capSteps;
      const sx = Math.cos(angle) * hw;
      const sy = Math.sin(angle) * hw;
      writeVertex(
        view,
        vStart + 1 + s,
        cx + tilt.inv00 * sx + tilt.inv01 * sy,
        cy + tilt.inv10 * sx + tilt.inv11 * sy,
        r,
        g,
        b,
        a,
        cz,
      );
      if (s > 0) {
        idx[iStart + (s - 1) * 3] = center;
        idx[iStart + (s - 1) * 3 + 1] = center + s;
        idx[iStart + (s - 1) * 3 + 2] = center + s + 1;
      }
    }
  };

  writeCap(4, 6, x1, y1, z1, Math.PI);
  writeCap(4 + vertsPerCap, 6 + capSteps * 3, x2, y2, z2, -Math.PI);
}
