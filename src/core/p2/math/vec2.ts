/* Copyright (c) 2013, Brandon Jones, Colin MacKenzie IV. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

  * Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. */

/**
 * The vec2 object from glMatrix, with some extensions and some removed methods.
 * See http://glmatrix.net.
 */

import { ARRAY_TYPE } from "../utils/Utils";

/**
 * A 2D vector represented as a 2-element array
 */
export type Vec2 = [number, number] | Float32Array;

/**
 * Make a cross product and only return the z component
 */
function crossLength(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/**
 * Cross product between a vector and the Z component of a vector
 */
function crossVZ(out: Vec2, vec: Vec2, zcomp: number): Vec2 {
  rotate(out, vec, -Math.PI / 2); // Rotate according to the right hand rule
  scale(out, out, zcomp); // Scale with z
  return out;
}

/**
 * Cross product between a vector and the Z component of a vector
 */
function crossZV(out: Vec2, zcomp: number, vec: Vec2): Vec2 {
  rotate(out, vec, Math.PI / 2); // Rotate according to the right hand rule
  scale(out, out, zcomp); // Scale with z
  return out;
}

/**
 * Rotate a vector by an angle
 */
function rotate(out: Vec2, a: Vec2, angle: number): void {
  if (angle !== 0) {
    const c = Math.cos(angle),
      s = Math.sin(angle),
      x = a[0],
      y = a[1];
    out[0] = c * x - s * y;
    out[1] = s * x + c * y;
  } else {
    out[0] = a[0];
    out[1] = a[1];
  }
}

/**
 * Rotate a vector 90 degrees clockwise
 */
function rotate90cw(out: Vec2, a: Vec2): void {
  const x = a[0];
  const y = a[1];
  out[0] = y;
  out[1] = -x;
}

/**
 * Transform a point position to local frame.
 */
function toLocalFrame(
  out: Vec2,
  worldPoint: Vec2,
  framePosition: Vec2,
  frameAngle: number
): void {
  copy(out, worldPoint);
  sub(out, out, framePosition);
  rotate(out, out, -frameAngle);
}

/**
 * Transform a point position to global frame.
 */
function toGlobalFrame(
  out: Vec2,
  localPoint: Vec2,
  framePosition: Vec2,
  frameAngle: number
): void {
  copy(out, localPoint);
  rotate(out, out, frameAngle);
  add(out, out, framePosition);
}

/**
 * Transform a vector to local frame.
 */
function vectorToLocalFrame(
  out: Vec2,
  worldVector: Vec2,
  frameAngle: number
): void {
  rotate(out, worldVector, -frameAngle);
}

/**
 * Transform a vector to global frame.
 */
function vectorToGlobalFrame(
  out: Vec2,
  localVector: Vec2,
  frameAngle: number
): void {
  rotate(out, localVector, frameAngle);
}

/**
 * Compute centroid of a triangle spanned by vectors a,b,c.
 */
function centroid(out: Vec2, a: Vec2, b: Vec2, c: Vec2): Vec2 {
  add(out, a, b);
  add(out, out, c);
  scale(out, out, 1 / 3);
  return out;
}

/**
 * Creates a new, empty vec2
 */
function create(): Vec2 {
  const out = new ARRAY_TYPE(2) as Vec2;
  out[0] = 0;
  out[1] = 0;
  return out;
}

/**
 * Creates a new vec2 initialized with values from an existing vector
 */
function clone(a: Vec2): Vec2 {
  const out = new ARRAY_TYPE(2) as Vec2;
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

/**
 * Creates a new vec2 initialized with the given values
 */
function fromValues(x: number, y: number): Vec2 {
  const out = new ARRAY_TYPE(2) as Vec2;
  out[0] = x;
  out[1] = y;
  return out;
}

/**
 * Copy the values from one vec2 to another
 */
function copy(out: Vec2, a: Vec2): Vec2 {
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

/**
 * Set the components of a vec2 to the given values
 */
function set(out: Vec2, x: number, y: number): Vec2 {
  out[0] = x;
  out[1] = y;
  return out;
}

/**
 * Adds two vec2's
 */
function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  return out;
}

/**
 * Subtracts two vec2's
 */
function subtract(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  return out;
}

/**
 * Alias for vec2.subtract
 */
const sub = subtract;

/**
 * Multiplies two vec2's
 */
function multiply(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out[0] = a[0] * b[0];
  out[1] = a[1] * b[1];
  return out;
}

/**
 * Alias for vec2.multiply
 */
const mul = multiply;

/**
 * Divides two vec2's
 */
function divide(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out[0] = a[0] / b[0];
  out[1] = a[1] / b[1];
  return out;
}

/**
 * Alias for vec2.divide
 */
const div = divide;

/**
 * Scales a vec2 by a scalar number
 */
function scale(out: Vec2, a: Vec2, b: number): Vec2 {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  return out;
}

/**
 * Calculates the euclidian distance between two vec2's
 */
function distance(a: Vec2, b: Vec2): number {
  const x = b[0] - a[0],
    y = b[1] - a[1];
  return Math.sqrt(x * x + y * y);
}

/**
 * Alias for vec2.distance
 */
const dist = distance;

/**
 * Calculates the squared euclidian distance between two vec2's
 */
function squaredDistance(a: Vec2, b: Vec2): number {
  const x = b[0] - a[0],
    y = b[1] - a[1];
  return x * x + y * y;
}

/**
 * Alias for vec2.squaredDistance
 */
const sqrDist = squaredDistance;

/**
 * Calculates the length of a vec2
 */
function length(a: Vec2): number {
  const x = a[0],
    y = a[1];
  return Math.sqrt(x * x + y * y);
}

/**
 * Alias for vec2.length
 */
const len = length;

/**
 * Calculates the squared length of a vec2
 */
function squaredLength(a: Vec2): number {
  const x = a[0],
    y = a[1];
  return x * x + y * y;
}

/**
 * Alias for vec2.squaredLength
 */
const sqrLen = squaredLength;

/**
 * Negates the components of a vec2
 */
function negate(out: Vec2, a: Vec2): Vec2 {
  out[0] = -a[0];
  out[1] = -a[1];
  return out;
}

/**
 * Normalize a vec2
 */
function normalize(out: Vec2, a: Vec2): Vec2 {
  const x = a[0],
    y = a[1];
  let len = x * x + y * y;
  if (len > 0) {
    len = 1 / Math.sqrt(len);
    out[0] = a[0] * len;
    out[1] = a[1] * len;
  }
  return out;
}

/**
 * Calculates the dot product of two vec2's
 */
function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/**
 * Returns a string representation of a vector
 */
function str(a: Vec2): string {
  return "vec2(" + a[0] + ", " + a[1] + ")";
}

/**
 * Linearly interpolate/mix two vectors.
 */
function lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  const ax = a[0],
    ay = a[1];
  out[0] = ax + t * (b[0] - ax);
  out[1] = ay + t * (b[1] - ay);
  return out;
}

/**
 * Reflect a vector along a normal.
 */
function reflect(out: Vec2, vector: Vec2, normal: Vec2): void {
  const d = vector[0] * normal[0] + vector[1] * normal[1];
  out[0] = vector[0] - 2 * normal[0] * d;
  out[1] = vector[1] - 2 * normal[1] * d;
}

/**
 * Get the intersection point between two line segments.
 */
function getLineSegmentsIntersection(
  out: Vec2,
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2
): boolean {
  const t = getLineSegmentsIntersectionFraction(p0, p1, p2, p3);
  if (t < 0) {
    return false;
  } else {
    out[0] = p0[0] + t * (p1[0] - p0[0]);
    out[1] = p0[1] + t * (p1[1] - p0[1]);
    return true;
  }
}

/**
 * Get the intersection fraction between two line segments.
 * If successful, the intersection is at p0 + t * (p1 - p0)
 * @returns A number between 0 and 1 if there was an intersection, otherwise -1.
 */
function getLineSegmentsIntersectionFraction(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2
): number {
  const s1_x = p1[0] - p0[0];
  const s1_y = p1[1] - p0[1];
  const s2_x = p3[0] - p2[0];
  const s2_y = p3[1] - p2[1];

  const s =
    (-s1_y * (p0[0] - p2[0]) + s1_x * (p0[1] - p2[1])) /
    (-s2_x * s1_y + s1_x * s2_y);
  const t =
    (s2_x * (p0[1] - p2[1]) - s2_y * (p0[0] - p2[0])) /
    (-s2_x * s1_y + s1_x * s2_y);
  if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
    // Collision detected
    return t;
  }
  return -1; // No collision
}

const vec2 = {
  crossLength,
  crossVZ,
  crossZV,
  rotate,
  rotate90cw,
  toLocalFrame,
  toGlobalFrame,
  vectorToLocalFrame,
  vectorToGlobalFrame,
  centroid,
  create,
  clone,
  fromValues,
  copy,
  set,
  add,
  subtract,
  sub,
  multiply,
  mul,
  divide,
  div,
  scale,
  distance,
  dist,
  squaredDistance,
  sqrDist,
  length,
  len,
  squaredLength,
  sqrLen,
  negate,
  normalize,
  dot,
  str,
  lerp,
  reflect,
  getLineSegmentsIntersection,
  getLineSegmentsIntersectionFraction,
};

export default vec2;
