import { V, V2d } from "../../core/Vector";

/**
 * Affine transform from boat-local 3D coordinates (x, y, z) to world 2D coordinates.
 *
 * The boat exists in a 2D physics world but has simulated tilt (roll/pitch).
 * When heeled, the boat appears narrower (y-axis foreshortening by cos(roll)),
 * and elements at different heights shift via parallax. The full 2×3 matrix:
 *
 *   [wx]   [cosA  -sinA·cosR  cosA·sp - sinA·sr] [x]   [hx]
 *   [wy] = [sinA   cosA·cosR  sinA·sp + cosA·sr] [y] + [hy]
 *                                                  [z]
 *
 * where A = hull angle, R = roll, sp = sin(pitch), sr = sin(roll),
 * cosR = cos(roll), (hx,hy) = hull position.
 *
 * Updated once per tick by Boat; read by all boat sub-entities for rendering.
 */
export class TiltTransform {
  // 2×3 matrix coefficients
  private m00 = 1;
  private m01 = 0;
  private m02 = 0;
  private m10 = 0;
  private m11 = 1;
  private m12 = 0;
  // Translation
  private tx = 0;
  private ty = 0;
  // Cached components
  private _sinRoll = 0;
  private _sinPitch = 0;
  private _cosRoll = 1;

  /** cos(roll) — y-axis foreshortening factor for hull-local drawing. */
  get cosRoll(): number {
    return this._cosRoll;
  }

  /** sin(roll) — lateral parallax factor for hull-local drawing. */
  get sinRoll(): number {
    return this._sinRoll;
  }

  /** sin(pitch) — fore/aft parallax factor for hull-local drawing. */
  get sinPitch(): number {
    return this._sinPitch;
  }

  /** Recompute the matrix. Called once per tick by Boat. */
  update(
    roll: number,
    pitch: number,
    hullAngle: number,
    hx: number,
    hy: number,
  ): void {
    const ca = Math.cos(hullAngle);
    const sa = Math.sin(hullAngle);
    const sr = Math.sin(roll);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);

    this.m00 = ca;
    this.m01 = -sa * cr;
    this.m02 = ca * sp - sa * sr;
    this.m10 = sa;
    this.m11 = ca * cr;
    this.m12 = sa * sp + ca * sr;
    this.tx = hx;
    this.ty = hy;
    this._sinRoll = sr;
    this._sinPitch = sp;
    this._cosRoll = cr;
  }

  /** Transform a boat-local 3D point (x, y, z) to world 2D. */
  toWorld(x: number, y: number, z: number): V2d {
    return V(
      this.m00 * x + this.m01 * y + this.m02 * z + this.tx,
      this.m10 * x + this.m11 * y + this.m12 * z + this.ty,
    );
  }

  /** World-space parallax offset for a given z-height (no position, no xy). */
  worldOffset(z: number): V2d {
    return V(this.m02 * z, this.m12 * z);
  }

  /** World-space X parallax offset for a given z-height. Scalar, no allocation. */
  worldOffsetX(z: number): number {
    return this.m02 * z;
  }

  /** World-space Y parallax offset for a given z-height. Scalar, no allocation. */
  worldOffsetY(z: number): number {
    return this.m12 * z;
  }

  /**
   * Hull-local parallax offset for a given z-height.
   * Use inside a draw.at() block that already applies hull position + angle.
   */
  localOffset(z: number): V2d {
    return V(z * this._sinPitch, z * this._sinRoll);
  }
}
