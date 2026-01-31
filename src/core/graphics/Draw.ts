import { earClipTriangulate } from "../util/Triangulate";
import { V, V2d } from "../Vector";
import { Camera2d } from "./Camera2d";
import {
  getCircleArrays,
  getCircleSegments,
  getCircleVertices,
} from "./draw/CircleHelpers";
import type {
  CircleOptions,
  DrawOptions,
  ImageOptions,
  LineOptions,
  SmoothOptions,
  SplineOptions,
} from "./draw/DrawOptions";
import { buildRoundedPolygonVertices } from "./draw/RoundedCorners";
import { buildCatmullRomSpline } from "./draw/SplineHelpers";
import { PathBuilder } from "./PathBuilder";
import { WebGPURenderer } from "./webgpu/WebGPURenderer";
import { WebGPUTexture } from "./webgpu/WebGPUTextureManager";

// Re-export PathBuilder for convenience
export { PathBuilder };

// Re-export option types for convenience
export type {
  CircleOptions,
  DrawOptions,
  ImageOptions,
  LineOptions,
  SmoothOptions,
  SplineOptions,
};

/**
 * High-level drawing API passed to entity onRender callbacks.
 * Provides a clean interface for drawing shapes, images, and paths.
 */
export class Draw {
  // Reusable arrays for common shapes to avoid allocations
  private _rectVertices: ReadonlyArray<V2d> = [V(), V(), V(), V()];
  private _rectIndices: ReadonlyArray<number> = [0, 1, 2, 0, 2, 3];
  private _triangleIndices: ReadonlyArray<number> = [0, 1, 2];
  private _lineVertices: ReadonlyArray<V2d> = [V(), V(), V(), V()];

  /** The underlying WebGPU renderer */
  readonly renderer: WebGPURenderer;
  /** The camera for coordinate conversions and zoom */
  readonly camera: Camera2d;

  constructor(renderer: WebGPURenderer, camera: Camera2d) {
    this.renderer = renderer;
    this.camera = camera;
  }

  /**
   * Execute draw commands at a specific position, rotation, and scale.
   * Automatically handles save/restore of transform state.
   *
   * @example
   * draw.at({ pos: this.position, angle: this.rotation }, () => {
   *   draw.fillRect(-10, -10, 20, 20, { color: 0xFF0000 });
   * });
   */
  at(
    { pos, angle, scale }: { pos: V2d; angle?: number; scale?: number | V2d },
    draw: () => void,
  ): void {
    this.renderer.saveTransform();
    this.renderer.translate(pos);

    if (angle !== undefined) {
      this.renderer.rotate(angle);
    }

    if (scale !== undefined) {
      if (typeof scale === "number") {
        this.renderer.scale(scale, scale);
      } else {
        this.renderer.scale(scale.x, scale.y);
      }
    }

    draw();

    this.renderer.restoreTransform();
  }

  /** Draw a filled rectangle */
  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: DrawOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;

    // Reuse vertices array and mutate in-place
    this._rectVertices[0].set(x, y);
    this._rectVertices[1].set(x + w, y);
    this._rectVertices[2].set(x + w, y + h);
    this._rectVertices[3].set(x, y + h);

    this.renderer.submitTriangles(
      this._rectVertices,
      this._rectIndices,
      color,
      alpha,
    );
  }

  /** Draw a stroked rectangle outline */
  strokeRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: LineOptions,
  ): void {
    // Reuse vertices array and mutate in-place
    this._rectVertices[0].set(x, y);
    this._rectVertices[1].set(x + w, y);
    this._rectVertices[2].set(x + w, y + h);
    this._rectVertices[3].set(x, y + h);
    this.strokePolygon(this._rectVertices, opts);
  }

  /** Draw a filled circle */
  fillCircle(x: number, y: number, radius: number, opts?: CircleOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const radiusOnScreen = radius * this.renderer.getCurrentScale();
    const segments = opts?.segments ?? getCircleSegments(radiusOnScreen);

    // Get cached unit circle vertices (no trig needed per-call)
    const cached = getCircleVertices(segments);
    const { vertices, indices } = getCircleArrays(segments);

    // Update center
    vertices[0].set(x, y);

    // Scale and translate cached unit circle
    for (let i = 0; i <= segments; i++) {
      vertices[i + 1].set(
        x + cached.cos[i] * radius,
        y + cached.sin[i] * radius,
      );
    }

    this.renderer.submitTriangles(vertices, indices, color, alpha);
  }

  /** Draw a stroked circle outline */
  strokeCircle(x: number, y: number, radius: number, opts?: LineOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const width = opts?.width ?? 1;
    const segments = getCircleSegments(radius);

    const path = this.path();
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) {
        path.moveTo(px, py);
      } else {
        path.lineTo(px, py);
      }
    }
    path.close().stroke(color, width, alpha);
  }

  fillTriangle(vertices: [V2d, V2d, V2d], opts?: DrawOptions): void {
    this.renderer.submitTriangles(
      vertices,
      this._triangleIndices,
      opts?.color ?? 0xffffff,
      opts?.alpha ?? 1.0,
    );
  }

  /** Draw a filled polygon (supports concave polygons) */
  fillPolygon(vertices: readonly V2d[], opts?: DrawOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;

    if (vertices.length < 3) return;

    // Use ear clipping for correct triangulation of concave polygons
    const indices = earClipTriangulate(vertices);
    if (!indices) return; // Triangulation failed (degenerate polygon)

    this.renderer.submitTriangles(vertices, indices, color, alpha);
  }

  /** Draw a stroked polygon outline */
  strokePolygon(vertices: readonly V2d[], opts?: LineOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const width = opts?.width ?? 1;

    if (vertices.length < 2) return;

    const path = this.path();
    path.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      path.lineTo(vertices[i].x, vertices[i].y);
    }
    path.close().stroke(color, width, alpha);
  }

  /** Draw a line (world-space width - scales with zoom) */
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: LineOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const width = opts?.width ?? 1;

    // Create a quad along the line
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;

    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);

    // Reuse vertices array and mutate in-place
    this._lineVertices[0].set(x1 + nx, y1 + ny);
    this._lineVertices[1].set(x2 + nx, y2 + ny);
    this._lineVertices[2].set(x2 - nx, y2 - ny);
    this._lineVertices[3].set(x1 - nx, y1 - ny);

    this.renderer.submitTriangles(
      this._lineVertices,
      this._rectIndices,
      color,
      alpha,
    );
  }

  /**
   * Draw a line with screen-space width (constant pixel width regardless of zoom).
   * Useful for UI elements and outlines that should always appear the same thickness.
   */
  screenLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: LineOptions,
  ): void {
    const adjustedOpts = opts ? { ...opts } : {};
    const width = adjustedOpts.width ?? 1;
    adjustedOpts.width = width / this.camera.z;
    this.line(x1, y1, x2, y2, adjustedOpts);
  }

  /** Draw a textured image/sprite */
  image(
    texture: WebGPUTexture,
    x: number,
    y: number,
    opts?: ImageOptions,
  ): void {
    this.renderer.drawImage(texture, x, y, opts);
  }

  /**
   * Start a new path for complex shapes.
   *
   * @example
   * draw.path()
   *   .moveTo(0, 0)
   *   .lineTo(10, 0)
   *   .lineTo(5, 10)
   *   .close()
   *   .fill(0xFF0000);
   */
  path(): PathBuilder {
    return new PathBuilder(this.renderer);
  }

  /** Draw a filled rounded rectangle */
  fillRoundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    opts?: DrawOptions,
  ): void {
    const vertices = [V(x, y), V(x + w, y), V(x + w, y + h), V(x, y + h)];
    this.fillRoundedPolygon(vertices, radius, opts);
  }

  /** Draw a stroked rounded rectangle */
  strokeRoundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    opts?: LineOptions,
  ): void {
    const vertices = [V(x, y), V(x + w, y), V(x + w, y + h), V(x, y + h)];
    this.strokeRoundedPolygon(vertices, radius, opts);
  }

  /** Draw a filled polygon with rounded corners */
  fillRoundedPolygon(
    vertices: readonly V2d[],
    radius: number,
    opts?: DrawOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;

    const roundedVertices = buildRoundedPolygonVertices(vertices, radius);
    if (roundedVertices.length < 3) return; // Not enough vertices to form a polygon

    // Simple fan triangulation (works for convex polygons)
    const indices: number[] = [];
    for (let i = 1; i < roundedVertices.length - 1; i++) {
      indices.push(0, i, i + 1);
    }

    this.renderer.submitTriangles(roundedVertices, indices, color, alpha);
  }

  /** Draw a stroked polygon with rounded corners */
  strokeRoundedPolygon(
    vertices: V2d[],
    radius: number,
    opts?: LineOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const width = opts?.width ?? 1;

    const roundedVertices = buildRoundedPolygonVertices(vertices, radius);
    if (roundedVertices.length < 2) return;

    const path = this.path();
    path.moveTo(roundedVertices[0].x, roundedVertices[0].y);
    for (let i = 1; i < roundedVertices.length; i++) {
      path.lineTo(roundedVertices[i].x, roundedVertices[i].y);
    }
    path.close().stroke(color, width, alpha);
  }

  /** Draw a filled smooth polygon using Catmull-Rom spline through control points */
  fillSmoothPolygon(vertices: V2d[], opts?: SmoothOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const tension = opts?.tension ?? 0.5;

    const splineVertices = buildCatmullRomSpline(vertices, true, tension);
    if (splineVertices.length < 3) return;

    // Use ear clipping for proper triangulation of concave polygons
    const indices = earClipTriangulate(splineVertices);

    // Skip rendering if triangulation failed (self-intersecting or degenerate polygon)
    if (!indices) return;

    this.renderer.submitTriangles(splineVertices, indices, color, alpha);
  }

  /** Draw a stroked smooth polygon using Catmull-Rom spline through control points */
  strokeSmoothPolygon(
    vertices: V2d[],
    opts?: SmoothOptions & LineOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const width = opts?.width ?? 1;
    const tension = opts?.tension ?? 0.5;

    const splineVertices = buildCatmullRomSpline(vertices, true, tension);
    if (splineVertices.length < 2) return;

    const path = this.path();
    path.moveTo(splineVertices[0].x, splineVertices[0].y);
    for (let i = 1; i < splineVertices.length; i++) {
      path.lineTo(splineVertices[i].x, splineVertices[i].y);
    }
    path.close().stroke(color, width, alpha);
  }

  /** Draw a smooth open curve (spline) through the given points */
  spline(vertices: V2d[], opts?: SplineOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const width = opts?.width ?? 1;
    const tension = opts?.tension ?? 0.5;

    const splineVertices = buildCatmullRomSpline(vertices, false, tension);
    if (splineVertices.length < 2) return;

    const path = this.path();
    path.moveTo(splineVertices[0].x, splineVertices[0].y);
    for (let i = 1; i < splineVertices.length; i++) {
      path.lineTo(splineVertices[i].x, splineVertices[i].y);
    }
    path.stroke(color, width, alpha);
  }
}
