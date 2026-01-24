import { clamp } from "../util/MathUtil";
import { earClipTriangulate } from "../util/Triangulate";
import { V, V2d } from "../Vector";
import { Camera2d } from "./Camera2d";
import { PathBuilder } from "./PathBuilder";
import { WebGPURenderer } from "./webgpu/WebGPURenderer";
import { WebGPUTexture } from "./webgpu/WebGPUTextureManager";

// Re-export PathBuilder for convenience
export { PathBuilder };

const MIN_CIRCLE_SEGMENTS = 4;
const MAX_CIRCLE_SEGMENTS = 64;

// Number of circle segments based on radius
function getCircleSegments(radius: number): number {
  return clamp(
    Math.floor(radius * 4),
    MIN_CIRCLE_SEGMENTS,
    MAX_CIRCLE_SEGMENTS,
  );
}

// Cache for pre-computed unit circle vertices
// Key: segment count, Value: array of [cos(angle), sin(angle)] for each vertex
const circleCache = new Map<number, { cos: Float32Array; sin: Float32Array }>();

function getCircleVertices(segments: number): {
  cos: Float32Array;
  sin: Float32Array;
} {
  let cached = circleCache.get(segments);
  if (!cached) {
    const cos = new Float32Array(segments + 1);
    const sin = new Float32Array(segments + 1);
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      cos[i] = Math.cos(angle);
      sin[i] = Math.sin(angle);
    }
    cached = { cos, sin };
    circleCache.set(segments, cached);
  }
  return cached;
}

// Number of segments for a Bézier corner based on offset
function getCornerSegments(offset: number): number {
  return clamp(Math.ceil(offset), 4, 12);
}

/**
 * Build vertices for a rounded polygon using quadratic Bézier corners.
 * Returns the tessellated vertices ready for rendering.
 */
function buildRoundedPolygonVertices(vertices: V2d[], radius: number): V2d[] {
  if (vertices.length < 3) return vertices;

  const result: V2d[] = [];

  for (let i = 0; i < vertices.length; i++) {
    const prev = vertices[(i - 1 + vertices.length) % vertices.length];
    const curr = vertices[i];
    const next = vertices[(i + 1) % vertices.length];

    // Edge vectors
    const toPrev = prev.sub(curr);
    const toNext = next.sub(curr);
    const prevLen = toPrev.magnitude;
    const nextLen = toNext.magnitude;

    // Clamp radius to half the shortest adjacent edge
    const maxRadius = Math.min(prevLen, nextLen) / 2;
    const r = Math.min(radius, maxRadius);

    if (r <= 0.001) {
      // No rounding needed
      result.push(curr.clone());
      continue;
    }

    // Offset points along edges
    const pStart = curr.add(toPrev.normalize().imul(r));
    const pEnd = curr.add(toNext.normalize().imul(r));

    // Generate quadratic Bézier curve with curr as control point
    const segments = getCornerSegments(r);
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      const t2 = t * t;
      const mt = 1 - t;
      const mt2 = mt * mt;

      // B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
      const px = mt2 * pStart.x + 2 * mt * t * curr.x + t2 * pEnd.x;
      const py = mt2 * pStart.y + 2 * mt * t * curr.y + t2 * pEnd.y;
      result.push(V(px, py));
    }
  }

  return result;
}

/**
 * Tessellate a Catmull-Rom spline through the given points.
 * @param points Control points the spline passes through
 * @param closed Whether to close the curve back to the start
 * @param tension Curve tightness (0-1, default 0.5)
 * @param segmentsPerSpan Segments per span between control points
 */
function buildCatmullRomSpline(
  points: V2d[],
  closed: boolean,
  tension: number = 0.5,
  segmentsPerSpan: number = 8,
): V2d[] {
  if (points.length < 2) return points.slice();

  const result: V2d[] = [];
  const n = points.length;

  // For Catmull-Rom, we need 4 points per segment: P0, P1, P2, P3
  // The curve is drawn between P1 and P2
  const segmentCount = closed ? n : n - 1;

  for (let i = 0; i < segmentCount; i++) {
    // Get the 4 control points for this segment
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    // For open splines, handle endpoints specially
    let actualP0 = p0;
    let actualP3 = p3;
    if (!closed) {
      if (i === 0) {
        // First segment: extrapolate P0
        actualP0 = V(2 * p1.x - p2.x, 2 * p1.y - p2.y);
      }
      if (i === n - 2) {
        // Last segment: extrapolate P3
        actualP3 = V(2 * p2.x - p1.x, 2 * p2.y - p1.y);
      }
    }

    // Compute tangents with tension
    const m1x = tension * (p2.x - actualP0.x);
    const m1y = tension * (p2.y - actualP0.y);
    const m2x = tension * (actualP3.x - p1.x);
    const m2y = tension * (actualP3.y - p1.y);

    // Generate points along this segment
    for (let j = 0; j < segmentsPerSpan; j++) {
      const t = j / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;

      // Hermite basis functions
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      const px = h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x;
      const py = h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y;
      result.push(V(px, py));
    }
  }

  // Add the final point
  if (closed) {
    result.push(points[0].clone());
  } else {
    result.push(points[n - 1].clone());
  }

  return result;
}

/** Options for shape drawing */
export interface DrawOptions {
  color?: number; // 0xRRGGBB
  alpha?: number; // 0-1
}

/** Options for line drawing */
export interface LineOptions extends DrawOptions {
  width?: number;
}

/** Options for smooth polygon drawing */
export interface SmoothOptions extends DrawOptions {
  tension?: number; // 0-1, default 0.5
}

/** Options for spline drawing */
export interface SplineOptions extends LineOptions {
  tension?: number; // 0-1, default 0.5
}

/** Options for sprite/image drawing */
export interface ImageOptions {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  color?: number; // 0xRRGGBB - tint color
  anchorX?: number; // 0-1, default 0.5
  anchorY?: number; // 0-1, default 0.5
}

/** Options for circle drawing */
export interface CircleOptions extends DrawOptions {
  /** Number of segments to use. If not specified, calculated from radius. */
  segments?: number;
}

/**
 * High-level drawing API passed to entity onRender callbacks.
 * Provides a clean interface for drawing shapes, images, and paths.
 */
export class Draw {
  constructor(
    /** The underlying WebGPU renderer */
    readonly renderer: WebGPURenderer,
    /** The camera for coordinate conversions and zoom */
    readonly camera: Camera2d,
  ) {}

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
    {
      pos,
      angle,
      scale,
    }: {
      pos: V2d;
      angle?: number;
      scale?: number | V2d;
    },
    draw: () => void,
  ): void {
    this.renderer.save();
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

    this.renderer.restore();
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

    const vertices: V2d[] = [
      V(x, y),
      V(x + w, y),
      V(x + w, y + h),
      V(x, y + h),
    ];

    this.renderer.submitTriangles(vertices, [0, 1, 2, 0, 2, 3], color, alpha);
  }

  /** Draw a stroked rectangle outline */
  strokeRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: LineOptions,
  ): void {
    const vertices = [V(x, y), V(x + w, y), V(x + w, y + h), V(x, y + h)];
    this.strokePolygon(vertices, opts);
  }

  /** Draw a filled circle */
  fillCircle(x: number, y: number, radius: number, opts?: CircleOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const radiusOnScreen = radius * this.renderer.getCurrentScale();
    const segments = opts?.segments ?? getCircleSegments(radiusOnScreen);

    // Get cached unit circle vertices (no trig needed per-call)
    const cached = getCircleVertices(segments);

    const vertices: V2d[] = [V(x, y)]; // Center
    const indices: number[] = [];

    // Scale and translate cached unit circle
    for (let i = 0; i <= segments; i++) {
      vertices.push(V(x + cached.cos[i] * radius, y + cached.sin[i] * radius));
    }

    for (let i = 1; i <= segments; i++) {
      indices.push(0, i, i + 1 > segments ? 1 : i + 1);
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

  /** Draw a filled polygon */
  fillPolygon(vertices: V2d[], opts?: DrawOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;

    if (vertices.length < 3) return;

    // Simple fan triangulation (works for convex polygons)
    const indices: number[] = [];
    for (let i = 1; i < vertices.length - 1; i++) {
      indices.push(0, i, i + 1);
    }

    this.renderer.submitTriangles(vertices, indices, color, alpha);
  }

  /** Draw a stroked polygon outline */
  strokePolygon(vertices: V2d[], opts?: LineOptions): void {
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

    const vertices: V2d[] = [
      V(x1 + nx, y1 + ny),
      V(x2 + nx, y2 + ny),
      V(x2 - nx, y2 - ny),
      V(x1 - nx, y1 - ny),
    ];

    this.renderer.submitTriangles(vertices, [0, 1, 2, 0, 2, 3], color, alpha);
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
    // Convert ImageOptions to SpriteOptions (color -> tint)
    const spriteOpts = opts
      ? {
          rotation: opts.rotation,
          scaleX: opts.scaleX,
          scaleY: opts.scaleY,
          alpha: opts.alpha,
          tint: opts.color,
          anchorX: opts.anchorX,
          anchorY: opts.anchorY,
        }
      : undefined;
    this.renderer.drawImage(texture, x, y, spriteOpts);
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
    vertices: V2d[],
    radius: number,
    opts?: DrawOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;

    const roundedVertices = buildRoundedPolygonVertices(vertices, radius);
    if (roundedVertices.length < 3) return;

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
