import { V2d } from "../Vector";
import { CachedMesh } from "./CachedMesh";
import { tessellateCircle } from "./tessellation/circle";
import { tessellateLine, tessellateScreenLine } from "./tessellation/line";
import {
  type PolylineOptions,
  tessellateScreenPolyline,
  tessellateWorldPolyline,
} from "./tessellation/polyline";
import {
  tessellateFillPolygon,
  tessellateStrokePolygon,
} from "./tessellation/polygon";
import {
  tessellateRect,
  tessellateRotatedRect,
} from "./tessellation/rectangle";
import {
  tessellateFillRoundedPolygon,
  tessellateStrokeRoundedPolygon,
} from "./tessellation/roundedPolygon";
import { tessellateScreenCircle } from "./tessellation/screenCircle";
import {
  tessellateFillSmoothPolygon,
  tessellateStrokeSmoothPolygon,
} from "./tessellation/smoothPolygon";
import { tessellateSpline } from "./tessellation/spline";
import { VERTEX_STRIDE_FLOATS, VertexSink } from "./tessellation/VertexSink";
import type { TiltProjection } from "./TiltProjection";

const INITIAL_VERTEX_CAPACITY = 256;
const INITIAL_INDEX_CAPACITY = 512;

/**
 * Builder that accumulates tessellated geometry into a private CPU buffer,
 * then produces an immutable `CachedMesh`.
 *
 * Mirrors `Draw`'s primitive surface (every fill* / stroke* / line method)
 * — the same tessellators power both. Screen-width primitives on this
 * builder take an explicit `TiltProjection` at build time; the mesh is
 * only valid for that projection.
 */
export class MeshBuilder implements VertexSink {
  private vertices: Float32Array;
  private indices: Uint32Array;
  private vertexCount = 0;
  private indexCount = 0;

  constructor(
    vertexCapacity: number = INITIAL_VERTEX_CAPACITY,
    indexCapacity: number = INITIAL_INDEX_CAPACITY,
  ) {
    this.vertices = new Float32Array(vertexCapacity * VERTEX_STRIDE_FLOATS);
    this.indices = new Uint32Array(indexCapacity);
  }

  /** Current vertex slot used — useful for caller diagnostics. */
  get currentVertexCount(): number {
    return this.vertexCount;
  }

  /** Reset for reuse without reallocation. */
  reset(): void {
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  /** Produce an immutable CachedMesh. Copies the trimmed vertex/index data. */
  build(): CachedMesh {
    const vBytes = this.vertexCount * VERTEX_STRIDE_FLOATS;
    const iBytes = this.indexCount;
    const vCopy = new Float32Array(vBytes);
    const iCopy = new Uint32Array(iBytes);
    vCopy.set(this.vertices.subarray(0, vBytes));
    iCopy.set(this.indices.subarray(0, iBytes));
    return new CachedMesh(vCopy, iCopy, this.vertexCount, this.indexCount);
  }

  // VertexSink impl -----------------------------------------------------------

  reserveVertices(n: number): { base: number; view: Float32Array } {
    const required = (this.vertexCount + n) * VERTEX_STRIDE_FLOATS;
    if (required > this.vertices.length) this.growVertices(required);
    const base = this.vertexCount;
    const start = base * VERTEX_STRIDE_FLOATS;
    const view = this.vertices.subarray(
      start,
      start + n * VERTEX_STRIDE_FLOATS,
    );
    this.vertexCount += n;
    return { base, view };
  }

  reserveIndices(n: number): Uint32Array {
    const required = this.indexCount + n;
    if (required > this.indices.length) this.growIndices(required);
    const start = this.indexCount;
    this.indexCount += n;
    return this.indices.subarray(start, start + n);
  }

  private growVertices(required: number): void {
    let cap = this.vertices.length;
    while (cap < required) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(this.vertices);
    this.vertices = grown;
  }

  private growIndices(required: number): void {
    let cap = this.indices.length;
    while (cap < required) cap *= 2;
    const grown = new Uint32Array(cap);
    grown.set(this.indices);
    this.indices = grown;
  }

  // ============ Fill primitives ============

  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: { color?: number; alpha?: number; z?: number },
  ): this {
    tessellateRect(
      this,
      x,
      y,
      w,
      h,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  fillRotatedRect(
    cx: number,
    cy: number,
    offsetX: number,
    offsetY: number,
    w: number,
    h: number,
    angle: number,
    opts?: { color?: number; alpha?: number; z?: number },
  ): this {
    tessellateRotatedRect(
      this,
      cx,
      cy,
      offsetX,
      offsetY,
      w,
      h,
      angle,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  fillCircle(
    x: number,
    y: number,
    radius: number,
    segments: number,
    opts?: { color?: number; alpha?: number; z?: number },
  ): this {
    tessellateCircle(
      this,
      x,
      y,
      radius,
      segments,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  fillPolygon(
    vertices: ReadonlyArray<{ x: number; y: number }>,
    opts?: { color?: number; alpha?: number; z?: number },
  ): this {
    tessellateFillPolygon(
      this,
      vertices,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  fillRoundedPolygon(
    vertices: V2d[],
    radius: number,
    opts?: { color?: number; alpha?: number; z?: number },
  ): this {
    tessellateFillRoundedPolygon(
      this,
      vertices,
      radius,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  fillSmoothPolygon(
    vertices: V2d[],
    opts?: { color?: number; alpha?: number; z?: number; tension?: number },
  ): this {
    tessellateFillSmoothPolygon(
      this,
      vertices,
      opts?.tension ?? 0.5,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  // ============ Stroke primitives ============

  strokePolygon(
    vertices: V2d[],
    opts?: { color?: number; alpha?: number; width?: number; z?: number },
  ): this {
    tessellateStrokePolygon(
      this,
      vertices,
      opts?.width ?? 1,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  strokeRoundedPolygon(
    vertices: V2d[],
    radius: number,
    opts?: { color?: number; alpha?: number; width?: number; z?: number },
  ): this {
    tessellateStrokeRoundedPolygon(
      this,
      vertices,
      radius,
      opts?.width ?? 1,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  strokeSmoothPolygon(
    vertices: V2d[],
    opts?: {
      color?: number;
      alpha?: number;
      width?: number;
      z?: number;
      tension?: number;
    },
  ): this {
    tessellateStrokeSmoothPolygon(
      this,
      vertices,
      opts?.tension ?? 0.5,
      opts?.width ?? 1,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  spline(
    vertices: V2d[],
    opts?: {
      color?: number;
      alpha?: number;
      width?: number;
      z?: number;
      tension?: number;
    },
  ): this {
    tessellateSpline(
      this,
      vertices,
      opts?.tension ?? 0.5,
      opts?.width ?? 1,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  // ============ Lines ============

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    opts?: { color?: number; alpha?: number; z?: number },
  ): this {
    tessellateLine(
      this,
      x1,
      y1,
      x2,
      y2,
      width,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.z ?? 0,
    );
    return this;
  }

  polyline(
    points: ReadonlyArray<readonly [number, number]>,
    zPerPoint: number | ReadonlyArray<number>,
    width: number,
    opts?: { color?: number; alpha?: number } & PolylineOptions,
  ): this {
    tessellateWorldPolyline(
      this,
      points,
      zPerPoint,
      width,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      {
        closed: opts?.closed,
        roundJoins: opts?.roundJoins,
        roundCaps: opts?.roundCaps,
      },
    );
    return this;
  }

  // ============ Screen-width primitives (caller-provided tilt) ============

  screenLine(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    width: number,
    tilt: TiltProjection,
    opts?: { color?: number; alpha?: number; roundCaps?: boolean },
  ): this {
    tessellateScreenLine(
      this,
      x1,
      y1,
      z1,
      x2,
      y2,
      z2,
      width,
      tilt,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      opts?.roundCaps ?? false,
    );
    return this;
  }

  screenPolyline(
    points: ReadonlyArray<readonly [number, number]>,
    zPerPoint: ReadonlyArray<number>,
    width: number,
    tilt: TiltProjection,
    opts?: { color?: number; alpha?: number } & PolylineOptions,
  ): this {
    tessellateScreenPolyline(
      this,
      points,
      zPerPoint,
      width,
      tilt,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
      {
        closed: opts?.closed,
        roundJoins: opts?.roundJoins,
        roundCaps: opts?.roundCaps,
      },
    );
    return this;
  }

  screenCircle(
    x: number,
    y: number,
    z: number,
    radius: number,
    segments: number,
    tilt: TiltProjection,
    opts?: { color?: number; alpha?: number },
  ): this {
    tessellateScreenCircle(
      this,
      x,
      y,
      z,
      radius,
      segments,
      tilt,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1,
    );
    return this;
  }
}
