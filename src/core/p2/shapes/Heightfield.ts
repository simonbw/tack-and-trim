import Shape, { ShapeOptions } from "./Shape";
import vec2, { Vec2 } from "../math/vec2";
import type AABB from "../collision/AABB";
import type RaycastResult from "../collision/RaycastResult";
import type Ray from "../collision/Ray";

export interface HeightfieldOptions extends ShapeOptions {
  heights?: number[];
  minValue?: number | null;
  maxValue?: number | null;
  elementWidth?: number;
}

const points = [vec2.create(), vec2.create(), vec2.create(), vec2.create()];

const intersectHeightfield_worldNormal = vec2.create();
const intersectHeightfield_l0 = vec2.create();
const intersectHeightfield_l1 = vec2.create();
const intersectHeightfield_localFrom = vec2.create();
const intersectHeightfield_localTo = vec2.create();

/**
 * Heightfield shape class. Height data is given as an array.
 */
export default class Heightfield extends Shape {
  heights: number[];
  maxValue: number | null;
  minValue: number | null;
  elementWidth: number;

  constructor(options: HeightfieldOptions = {}) {
    const opts = { ...options, type: Shape.HEIGHTFIELD };
    super(opts);

    this.heights = options.heights ? options.heights.slice(0) : [];
    this.maxValue = options.maxValue ?? null;
    this.minValue = options.minValue ?? null;
    this.elementWidth = options.elementWidth ?? 0.1;

    if (options.maxValue === undefined || options.minValue === undefined) {
      this.updateMaxMinValues();
    }

    this.updateBoundingRadius();
    this.updateArea();
  }

  updateMaxMinValues(): void {
    const data = this.heights;
    let maxValue = data[0];
    let minValue = data[0];

    for (let i = 0; i !== data.length; i++) {
      const v = data[i];
      if (v > maxValue) {
        maxValue = v;
      }
      if (v < minValue) {
        minValue = v;
      }
    }

    this.maxValue = maxValue;
    this.minValue = minValue;
  }

  computeMomentOfInertia(_mass: number): number {
    return Number.MAX_VALUE;
  }

  updateBoundingRadius(): void {
    this.boundingRadius = Number.MAX_VALUE;
  }

  updateArea(): void {
    const data = this.heights;
    let area = 0;
    for (let i = 0; i < data.length - 1; i++) {
      area += ((data[i] + data[i + 1]) / 2) * this.elementWidth;
    }
    this.area = area;
  }

  computeAABB(out: AABB, position: Vec2, angle: number): void {
    vec2.set(points[0], 0, this.maxValue!);
    vec2.set(points[1], this.elementWidth * this.heights.length, this.maxValue!);
    vec2.set(points[2], this.elementWidth * this.heights.length, this.minValue!);
    vec2.set(points[3], 0, this.minValue!);
    out.setFromPoints(points, position, angle);
  }

  getLineSegment(start: Vec2, end: Vec2, i: number): void {
    const data = this.heights;
    const width = this.elementWidth;
    vec2.set(start, i * width, data[i]);
    vec2.set(end, (i + 1) * width, data[i + 1]);
  }

  getSegmentIndex(position: Vec2): number {
    return Math.floor(position[0] / this.elementWidth);
  }

  getClampedSegmentIndex(position: Vec2): number {
    let i = this.getSegmentIndex(position);
    i = Math.min(this.heights.length, Math.max(i, 0));
    return i;
  }

  raycast(result: RaycastResult, ray: Ray, position: Vec2, angle: number): void {
    const from = ray.from;
    const to = ray.to;

    const worldNormal = intersectHeightfield_worldNormal;
    const l0 = intersectHeightfield_l0;
    const l1 = intersectHeightfield_l1;
    const localFrom = intersectHeightfield_localFrom;
    const localTo = intersectHeightfield_localTo;

    // get local ray start and end
    vec2.toLocalFrame(localFrom, from, position, angle);
    vec2.toLocalFrame(localTo, to, position, angle);

    // The segments
    for (let i = 0; i < this.heights.length - 1; i++) {
      this.getLineSegment(l0, l1, i);
      const t = vec2.getLineSegmentsIntersectionFraction(
        localFrom,
        localTo,
        l0,
        l1
      );
      if (t >= 0) {
        vec2.sub(worldNormal, l1, l0);
        vec2.rotate(worldNormal, worldNormal, angle + Math.PI / 2);
        vec2.normalize(worldNormal, worldNormal);
        ray.reportIntersection(result, t, worldNormal, -1);
        if (result.shouldStop(ray)) {
          return;
        }
      }
    }
  }
}
