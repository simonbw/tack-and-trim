import type { TiltProjection } from "../TiltProjection";
import { unpackColor } from "./color";
import { VertexSink, writeVertex } from "./VertexSink";

/**
 * Tilt-aware circle: maintains a circular screen-space shape regardless
 * of hull roll/pitch by inverse-projecting screen-space offsets back to
 * local space.
 */
export function tessellateScreenCircle(
  sink: VertexSink,
  cx: number,
  cy: number,
  z: number,
  radius: number,
  segments: number,
  tilt: TiltProjection,
  color: number,
  alpha: number,
  lightAffected: number,
): void {
  const { r, g, b, a } = unpackColor(color, alpha);
  const { base, view } = sink.reserveVertices(segments + 2);

  writeVertex(view, 0, cx, cy, r, g, b, a, lightAffected, z);
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const sx = Math.cos(angle) * radius;
    const sy = Math.sin(angle) * radius;
    writeVertex(
      view,
      i + 1,
      cx + tilt.inv00 * sx + tilt.inv01 * sy,
      cy + tilt.inv10 * sx + tilt.inv11 * sy,
      r,
      g,
      b,
      a,
      lightAffected,
      z,
    );
  }

  const idx = sink.reserveIndices(segments * 3);
  for (let i = 0; i < segments; i++) {
    idx[i * 3] = base;
    idx[i * 3 + 1] = base + 1 + i;
    idx[i * 3 + 2] = base + 1 + ((i + 1) % (segments + 1));
  }
}
