/**
 * Tilt projection parameters for the hull's Yaw·Pitch·Roll rotation.
 *
 * Used by screen-width tessellation (lines, polylines, circles whose on-screen
 * thickness shouldn't depend on tilt). The forward matrix projects local-space
 * directions to screen space; the inverse converts a screen-space perpendicular
 * back to local-space offsets so the GPU's own tilt transform reproduces the
 * desired constant-width screen output.
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
