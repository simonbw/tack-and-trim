import Shape, { ShapeOptions } from "./Shape";
import { V, V2d, CompatibleVector } from "../../Vector";
import { Triangulate } from "../math/polyk";
import AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface ConvexOptions extends ShapeOptions {
  vertices?: CompatibleVector[];
  axes?: CompatibleVector[];
}

/**
 * Convex shape class.
 */
export default class Convex extends Shape {
  vertices: V2d[];
  axes: V2d[];
  centerOfMass: V2d;
  triangles: number[][];

  constructor(options: ConvexOptions = {}) {
    const opts = { ...options, type: Shape.CONVEX };
    super(opts);

    this.vertices = [];

    // Copy the verts
    const vertices = options.vertices ?? [];
    for (let i = 0; i < vertices.length; i++) {
      const v = V();
      v.set(vertices[i]);
      this.vertices.push(v);
    }

    this.axes = [];

    if (options.axes) {
      // Copy the axes
      for (let i = 0; i < options.axes.length; i++) {
        const axis = V();
        axis.set(options.axes[i]);
        this.axes.push(axis);
      }
    } else {
      // Construct axes from the vertex data
      for (let i = 0; i < this.vertices.length; i++) {
        const worldPoint0 = this.vertices[i];
        const worldPoint1 = this.vertices[(i + 1) % this.vertices.length];

        const normal = V();
        normal.set(worldPoint1).isub(worldPoint0);

        // Get normal - just rotate 90 degrees since vertices are given in CCW
        normal.irotate90cw();
        normal.inormalize();

        this.axes.push(normal);
      }
    }

    this.centerOfMass = V();
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

  projectOntoLocalAxis(localAxis: V2d): V2d {
    let max: number | null = null;
    let min: number | null = null;
    const axis = V(localAxis);

    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      const value = v.dot(axis);
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

    return V(min!, max!);
  }

  projectOntoWorldAxis(
    localAxis: V2d,
    shapeOffset: V2d,
    shapeAngle: number
  ): V2d {
    const result = this.projectOntoLocalAxis(localAxis);

    // Project the position of the body onto the axis
    const worldAxis = shapeAngle !== 0
      ? V(localAxis).rotate(shapeAngle)
      : V(localAxis);
    const offset = shapeOffset.dot(worldAxis);

    return V(result[0] + offset, result[1] + offset);
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
    const triangles = Triangulate(polykVerts);

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

    cm.set(0, 0);
    let totalArea = 0;

    for (let i = 0; i !== triangles.length; i++) {
      const t = triangles[i];
      const a = verts[t[0]];
      const b = verts[t[1]];
      const c = verts[t[2]];

      const centroid = V2d.centroid(a, b, c);

      const m = Convex.triangleArea(a, b, c);
      totalArea += m;

      const centroid_times_mass = V(centroid).mul(m);
      cm.iadd(centroid_times_mass);
    }

    cm.imul(1 / totalArea);
  }

  computeMomentOfInertia(mass: number): number {
    let denom = 0.0;
    let numer = 0.0;
    const N = this.vertices.length;

    for (let j = N - 1, i = 0; i < N; j = i, i++) {
      const p0 = this.vertices[j];
      const p1 = this.vertices[i];
      const a = Math.abs(p0.crossLength(p1));
      const b = p1.dot(p1) + p1.dot(p0) + p0.dot(p0);
      denom += a * b;
      numer += a;
    }

    return (mass / 6.0) * (denom / numer);
  }

  updateBoundingRadius(): void {
    const verts = this.vertices;
    let r2 = 0;

    for (let i = 0; i !== verts.length; i++) {
      const l2 = verts[i].squaredMagnitude;
      if (l2 > r2) {
        r2 = l2;
      }
    }

    this.boundingRadius = Math.sqrt(r2);
  }

  static triangleArea(a: V2d, b: V2d, c: V2d): number {
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

  computeAABB(position: V2d, angle: number): AABB {
    const out = new AABB();
    out.setFromPoints(this.vertices, position, angle, 0);
    return out;
  }

  raycast(result: RaycastResult, ray: Ray, position: V2d, angle: number): void {
    const vertices = this.vertices;

    // Transform to local shape space
    const rayStart = V(ray.from).toLocalFrame(position, angle);
    const rayEnd = V(ray.to).toLocalFrame(position, angle);

    const n = vertices.length;

    for (let i = 0; i < n && !result.shouldStop(ray); i++) {
      const q1 = vertices[i];
      const q2 = vertices[(i + 1) % n];
      const delta = V2d.lineSegmentsIntersectionFraction(
        rayStart,
        rayEnd,
        q1,
        q2
      );

      if (delta >= 0) {
        const normal = V(q2).sub(q1);
        normal.irotate(-Math.PI / 2 + angle);
        normal.inormalize();
        ray.reportIntersection(result, delta, normal, i);
      }
    }
  }
}
