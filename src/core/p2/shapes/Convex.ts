import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
import * as polyk from "../math/polyk";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface ConvexOptions extends ShapeOptions {
  vertices?: Vec2[];
  axes?: Vec2[];
}

const tmpVec1 = vec2.create();
const tmpVec2 = vec2.create();

const updateCenterOfMass_centroid = vec2.create();
const updateCenterOfMass_centroid_times_mass = vec2.create();

const intersectConvex_rayStart = vec2.create();
const intersectConvex_rayEnd = vec2.create();
const intersectConvex_normal = vec2.create();

/**
 * Convex shape class.
 */
export default class Convex extends Shape {
  vertices: Vec2[];
  axes: Vec2[];
  centerOfMass: Vec2;
  triangles: number[][];

  constructor(options: ConvexOptions = {}) {
    const opts = { ...options, type: Shape.CONVEX };
    super(opts);

    this.vertices = [];

    // Copy the verts
    const vertices = options.vertices ?? [];
    for (let i = 0; i < vertices.length; i++) {
      const v = vec2.create();
      vec2.copy(v, vertices[i]);
      this.vertices.push(v);
    }

    this.axes = [];

    if (options.axes) {
      // Copy the axes
      for (let i = 0; i < options.axes.length; i++) {
        const axis = vec2.create();
        vec2.copy(axis, options.axes[i]);
        this.axes.push(axis);
      }
    } else {
      // Construct axes from the vertex data
      for (let i = 0; i < this.vertices.length; i++) {
        const worldPoint0 = this.vertices[i];
        const worldPoint1 = this.vertices[(i + 1) % this.vertices.length];

        const normal = vec2.create();
        vec2.sub(normal, worldPoint1, worldPoint0);

        // Get normal - just rotate 90 degrees since vertices are given in CCW
        vec2.rotate90cw(normal, normal);
        vec2.normalize(normal, normal);

        this.axes.push(normal);
      }
    }

    this.centerOfMass = vec2.fromValues(0, 0);
    this.triangles = [];

    if (this.vertices.length) {
      this.updateTriangles();
      this.updateCenterOfMass();
    }

    this.boundingRadius = 0;
    this.updateBoundingRadius();
    this.updateArea();

    if (this.area < 0) {
      throw new Error("Convex vertices must be given in counter-clockwise winding.");
    }
  }

  projectOntoLocalAxis(localAxis: Vec2, result: Vec2): void {
    let max: number | null = null;
    let min: number | null = null;
    const axis = tmpVec1;
    vec2.copy(axis, localAxis);

    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      const value = vec2.dot(v, axis);
      if (max === null || value > max) {
        max = value;
      }
      if (min === null || value < min) {
        min = value;
      }
    }

    if (min! > max!) {
      const t = min;
      min = max;
      max = t;
    }

    vec2.set(result, min!, max!);
  }

  projectOntoWorldAxis(
    localAxis: Vec2,
    shapeOffset: Vec2,
    shapeAngle: number,
    result: Vec2
  ): void {
    let worldAxis = tmpVec2;

    this.projectOntoLocalAxis(localAxis, result);

    // Project the position of the body onto the axis
    if (shapeAngle !== 0) {
      vec2.rotate(worldAxis, localAxis, shapeAngle);
    } else {
      worldAxis = localAxis;
    }
    const offset = vec2.dot(shapeOffset, worldAxis);

    vec2.set(result, result[0] + offset, result[1] + offset);
  }

  updateTriangles(): void {
    this.triangles.length = 0;

    // Rewrite on polyk notation, array of numbers
    const polykVerts: number[] = [];
    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      polykVerts.push(v[0], v[1]);
    }

    // Triangulate
    const triangles = polyk.Triangulate(polykVerts);

    // Loop over all triangles
    for (let i = 0; i < triangles.length; i += 3) {
      const id1 = triangles[i];
      const id2 = triangles[i + 1];
      const id3 = triangles[i + 2];

      this.triangles.push([id1, id2, id3]);
    }
  }

  updateCenterOfMass(): void {
    const triangles = this.triangles;
    const verts = this.vertices;
    const cm = this.centerOfMass;
    const centroid = updateCenterOfMass_centroid;
    const centroid_times_mass = updateCenterOfMass_centroid_times_mass;

    vec2.set(cm, 0, 0);
    let totalArea = 0;

    for (let i = 0; i !== triangles.length; i++) {
      const t = triangles[i];
      const a = verts[t[0]];
      const b = verts[t[1]];
      const c = verts[t[2]];

      vec2.centroid(centroid, a, b, c);

      const m = Convex.triangleArea(a, b, c);
      totalArea += m;

      vec2.scale(centroid_times_mass, centroid, m);
      vec2.add(cm, cm, centroid_times_mass);
    }

    vec2.scale(cm, cm, 1 / totalArea);
  }

  computeMomentOfInertia(mass: number): number {
    let denom = 0.0;
    let numer = 0.0;
    const N = this.vertices.length;

    for (let j = N - 1, i = 0; i < N; j = i, i++) {
      const p0 = this.vertices[j];
      const p1 = this.vertices[i];
      const a = Math.abs(vec2.crossLength(p0, p1));
      const b = vec2.dot(p1, p1) + vec2.dot(p1, p0) + vec2.dot(p0, p0);
      denom += a * b;
      numer += a;
    }

    return (mass / 6.0) * (denom / numer);
  }

  updateBoundingRadius(): void {
    const verts = this.vertices;
    let r2 = 0;

    for (let i = 0; i !== verts.length; i++) {
      const l2 = vec2.squaredLength(verts[i]);
      if (l2 > r2) {
        r2 = l2;
      }
    }

    this.boundingRadius = Math.sqrt(r2);
  }

  static triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
    return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5;
  }

  updateArea(): void {
    this.updateTriangles();
    this.area = 0;

    const triangles = this.triangles;
    const verts = this.vertices;

    for (let i = 0; i !== triangles.length; i++) {
      const t = triangles[i];
      const a = verts[t[0]];
      const b = verts[t[1]];
      const c = verts[t[2]];

      const m = Convex.triangleArea(a, b, c);
      this.area += m;
    }
  }

  computeAABB(out: AABB, position: Vec2, angle: number): void {
    out.setFromPoints(this.vertices, position, angle, 0);
  }

  raycast(result: RaycastResult, ray: Ray, position: Vec2, angle: number): void {
    const rayStart = intersectConvex_rayStart;
    const rayEnd = intersectConvex_rayEnd;
    const normal = intersectConvex_normal;
    const vertices = this.vertices;

    // Transform to local shape space
    vec2.toLocalFrame(rayStart, ray.from, position, angle);
    vec2.toLocalFrame(rayEnd, ray.to, position, angle);

    const n = vertices.length;

    for (let i = 0; i < n && !result.shouldStop(ray); i++) {
      const q1 = vertices[i];
      const q2 = vertices[(i + 1) % n];
      const delta = vec2.getLineSegmentsIntersectionFraction(
        rayStart,
        rayEnd,
        q1,
        q2
      );

      if (delta >= 0) {
        vec2.sub(normal, q2, q1);
        vec2.rotate(normal, normal, -Math.PI / 2 + angle);
        vec2.normalize(normal, normal);
        ray.reportIntersection(result, delta, normal, i);
      }
    }
  }
}
