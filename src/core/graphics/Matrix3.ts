import { V, V2d, CompatibleVector } from "../Vector";

/**
 * A 3x3 matrix for 2D affine transformations.
 * Stored in column-major order for WebGL compatibility:
 * [a, b, 0, c, d, 0, tx, ty, 1]
 *
 * Matrix layout:
 * | a  c  tx |
 * | b  d  ty |
 * | 0  0  1  |
 */
export class Matrix3 {
  /** Internal storage in column-major order */
  private data: Float32Array;

  constructor() {
    this.data = new Float32Array(9);
    this.identity();
  }

  /** Create an identity matrix */
  static identity(): Matrix3 {
    return new Matrix3();
  }

  /** Create a translation matrix */
  static translation(x: number, y: number): Matrix3 {
    const m = new Matrix3();
    m.data[6] = x;
    m.data[7] = y;
    return m;
  }

  /** Create a rotation matrix (angle in radians) */
  static rotation(radians: number): Matrix3 {
    const m = new Matrix3();
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    m.data[0] = c;
    m.data[1] = s;
    m.data[3] = -s;
    m.data[4] = c;
    return m;
  }

  /** Create a scaling matrix */
  static scaling(sx: number, sy: number = sx): Matrix3 {
    const m = new Matrix3();
    m.data[0] = sx;
    m.data[4] = sy;
    return m;
  }

  /** Clone this matrix */
  clone(): Matrix3 {
    const m = new Matrix3();
    m.data.set(this.data);
    return m;
  }

  /** Reset to identity */
  identity(): this {
    this.data[0] = 1;
    this.data[1] = 0;
    this.data[2] = 0;
    this.data[3] = 0;
    this.data[4] = 1;
    this.data[5] = 0;
    this.data[6] = 0;
    this.data[7] = 0;
    this.data[8] = 1;
    return this;
  }

  /** Set from individual values (row-major input for convenience) */
  set(
    a: number,
    c: number,
    tx: number,
    b: number,
    d: number,
    ty: number
  ): this {
    this.data[0] = a;
    this.data[1] = b;
    this.data[2] = 0;
    this.data[3] = c;
    this.data[4] = d;
    this.data[5] = 0;
    this.data[6] = tx;
    this.data[7] = ty;
    this.data[8] = 1;
    return this;
  }

  /** Copy from another matrix */
  copyFrom(other: Matrix3): this {
    this.data.set(other.data);
    return this;
  }

  /** Translate by (x, y) - modifies this matrix */
  translate(x: number, y: number): this;
  translate(v: CompatibleVector): this;
  translate(xOrV: number | CompatibleVector, y?: number): this {
    let tx: number, ty: number;
    if (typeof xOrV === "number") {
      tx = xOrV;
      ty = y!;
    } else {
      tx = xOrV[0];
      ty = xOrV[1];
    }

    // Multiply by translation matrix on the right
    this.data[6] += this.data[0] * tx + this.data[3] * ty;
    this.data[7] += this.data[1] * tx + this.data[4] * ty;
    return this;
  }

  /** Rotate by angle (radians) - modifies this matrix */
  rotate(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);

    const a = this.data[0];
    const b = this.data[1];
    const d = this.data[3];
    const e = this.data[4];

    this.data[0] = a * c + d * s;
    this.data[1] = b * c + e * s;
    this.data[3] = a * -s + d * c;
    this.data[4] = b * -s + e * c;

    return this;
  }

  /** Scale by (sx, sy) - modifies this matrix */
  scale(s: number): this;
  scale(sx: number, sy: number): this;
  scale(sx: number, sy?: number): this {
    const scaleY = sy ?? sx;
    this.data[0] *= sx;
    this.data[1] *= sx;
    this.data[3] *= scaleY;
    this.data[4] *= scaleY;
    return this;
  }

  /** Multiply this matrix by another: this = this * other */
  multiply(other: Matrix3): this {
    const a1 = this.data[0],
      b1 = this.data[1];
    const c1 = this.data[3],
      d1 = this.data[4];
    const tx1 = this.data[6],
      ty1 = this.data[7];

    const a2 = other.data[0],
      b2 = other.data[1];
    const c2 = other.data[3],
      d2 = other.data[4];
    const tx2 = other.data[6],
      ty2 = other.data[7];

    this.data[0] = a1 * a2 + c1 * b2;
    this.data[1] = b1 * a2 + d1 * b2;
    this.data[3] = a1 * c2 + c1 * d2;
    this.data[4] = b1 * c2 + d1 * d2;
    this.data[6] = a1 * tx2 + c1 * ty2 + tx1;
    this.data[7] = b1 * tx2 + d1 * ty2 + ty1;

    return this;
  }

  /** Premultiply this matrix by another: this = other * this */
  premultiply(other: Matrix3): this {
    const a1 = other.data[0],
      b1 = other.data[1];
    const c1 = other.data[3],
      d1 = other.data[4];
    const tx1 = other.data[6],
      ty1 = other.data[7];

    const a2 = this.data[0],
      b2 = this.data[1];
    const c2 = this.data[3],
      d2 = this.data[4];
    const tx2 = this.data[6],
      ty2 = this.data[7];

    this.data[0] = a1 * a2 + c1 * b2;
    this.data[1] = b1 * a2 + d1 * b2;
    this.data[3] = a1 * c2 + c1 * d2;
    this.data[4] = b1 * c2 + d1 * d2;
    this.data[6] = a1 * tx2 + c1 * ty2 + tx1;
    this.data[7] = b1 * tx2 + d1 * ty2 + ty1;

    return this;
  }

  /** Invert this matrix - modifies this matrix */
  invert(): this {
    const a = this.data[0],
      b = this.data[1];
    const c = this.data[3],
      d = this.data[4];
    const tx = this.data[6],
      ty = this.data[7];

    const det = a * d - b * c;
    if (det === 0) {
      // Matrix is not invertible, reset to identity
      return this.identity();
    }

    const invDet = 1 / det;

    this.data[0] = d * invDet;
    this.data[1] = -b * invDet;
    this.data[3] = -c * invDet;
    this.data[4] = a * invDet;
    this.data[6] = (c * ty - d * tx) * invDet;
    this.data[7] = (b * tx - a * ty) * invDet;

    return this;
  }

  /** Apply this matrix to a point, returning a new V2d */
  apply(point: CompatibleVector): V2d {
    const x = point[0];
    const y = point[1];
    return V(
      this.data[0] * x + this.data[3] * y + this.data[6],
      this.data[1] * x + this.data[4] * y + this.data[7]
    );
  }

  /** Apply the inverse of this matrix to a point, returning a new V2d */
  applyInverse(point: CompatibleVector): V2d {
    const a = this.data[0],
      b = this.data[1];
    const c = this.data[3],
      d = this.data[4];
    const tx = this.data[6],
      ty = this.data[7];

    const det = a * d - b * c;
    if (det === 0) {
      return V(0, 0);
    }

    const invDet = 1 / det;
    const x = point[0] - tx;
    const y = point[1] - ty;

    return V((d * x - c * y) * invDet, (a * y - b * x) * invDet);
  }

  /** Get the underlying array (column-major for WebGL) */
  toArray(): Float32Array;
  toArray(transpose: boolean): Float32Array;
  toArray(transpose: boolean, out: Float32Array): Float32Array;
  toArray(transpose: boolean = false, out?: Float32Array): Float32Array {
    const result = out ?? new Float32Array(9);

    if (transpose) {
      // Row-major order
      result[0] = this.data[0];
      result[1] = this.data[3];
      result[2] = this.data[6];
      result[3] = this.data[1];
      result[4] = this.data[4];
      result[5] = this.data[7];
      result[6] = this.data[2];
      result[7] = this.data[5];
      result[8] = this.data[8];
    } else {
      // Column-major order (default for WebGL)
      result.set(this.data);
    }

    return result;
  }

  /** Get individual matrix elements (row, col) */
  get a(): number {
    return this.data[0];
  }
  get b(): number {
    return this.data[1];
  }
  get c(): number {
    return this.data[3];
  }
  get d(): number {
    return this.data[4];
  }
  get tx(): number {
    return this.data[6];
  }
  get ty(): number {
    return this.data[7];
  }

  /** Set individual matrix elements */
  set a(value: number) {
    this.data[0] = value;
  }
  set b(value: number) {
    this.data[1] = value;
  }
  set c(value: number) {
    this.data[3] = value;
  }
  set d(value: number) {
    this.data[4] = value;
  }
  set tx(value: number) {
    this.data[6] = value;
  }
  set ty(value: number) {
    this.data[7] = value;
  }

  /** Get the determinant of this matrix */
  get determinant(): number {
    return this.data[0] * this.data[4] - this.data[1] * this.data[3];
  }

  /** Decompose this matrix into translation, rotation, scale, and skew */
  decompose(): {
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    skewX: number;
    skewY: number;
  } {
    const a = this.data[0];
    const b = this.data[1];
    const c = this.data[3];
    const d = this.data[4];

    const skewX = Math.atan2(-c, d);
    const skewY = Math.atan2(b, a);

    const rotation = skewY;
    const scaleX = Math.sqrt(a * a + b * b);
    const scaleY = Math.sqrt(c * c + d * d);

    return {
      x: this.data[6],
      y: this.data[7],
      rotation,
      scaleX,
      scaleY,
      skewX,
      skewY,
    };
  }
}
