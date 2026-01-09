import { V, V2d } from "../Vector";
import { Camera2d } from "./Camera2d";
import { Texture } from "./TextureManager";
import { DrawOptions, LineOptions, WebGLRenderer } from "./WebGLRenderer";

// Number of circle segments based on radius
function getCircleSegments(radius: number): number {
  return Math.max(16, Math.min(64, Math.floor(radius * 4)));
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

// Re-export types from WebGLRenderer for convenience
export type { DrawOptions, LineOptions };

/**
 * Self-contained fluent path builder for complex shapes.
 * Stores path state internally and converts to triangles on fill/stroke.
 */
export class PathBuilder {
  private points: V2d[] = [];
  private pathStarted = false;
  private closed = false;

  constructor(private renderer: WebGLRenderer) {}

  /** Move to a point without drawing */
  moveTo(x: number, y: number): this {
    this.points = [V(x, y)];
    this.pathStarted = true;
    return this;
  }

  /** Draw a line to a point */
  lineTo(x: number, y: number): this {
    if (!this.pathStarted) {
      this.moveTo(x, y);
    } else {
      this.points.push(V(x, y));
    }
    return this;
  }

  /** Draw a quadratic curve */
  quadraticTo(cpx: number, cpy: number, x: number, y: number): this {
    if (!this.pathStarted || this.points.length === 0) {
      this.moveTo(cpx, cpy);
      this.lineTo(x, y);
      return this;
    }

    // Approximate quadratic bezier with line segments
    const start = this.points[this.points.length - 1];
    const cp = V(cpx, cpy);
    const end = V(x, y);
    const segments = 8;

    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const t2 = t * t;
      const mt = 1 - t;
      const mt2 = mt * mt;

      // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
      const px = mt2 * start.x + 2 * mt * t * cp.x + t2 * end.x;
      const py = mt2 * start.y + 2 * mt * t * cp.y + t2 * end.y;
      this.points.push(V(px, py));
    }
    return this;
  }

  /** Close the path back to the starting point */
  close(): this {
    this.closed = true;
    return this;
  }

  /** Fill the path with a color */
  fill(color: number, alpha: number = 1): void {
    if (this.points.length < 3) return;

    // Simple fan triangulation (works for convex polygons)
    const indices: number[] = [];
    for (let i = 1; i < this.points.length - 1; i++) {
      indices.push(0, i, i + 1);
    }

    this.renderer.submitTriangles(this.points, indices, color, alpha);
  }

  /** Stroke the path outline */
  stroke(color: number, width: number = 1, alpha: number = 1): void {
    const points = this.points;
    if (points.length < 2) return;

    // For closed paths, we need to handle the wrap-around at start/end
    const shouldClose = this.closed && points.length >= 3;

    const halfWidth = width / 2;
    const vertices: V2d[] = [];
    const indices: number[] = [];

    // Helper to get perpendicular (rotate 90 degrees CCW)
    const perp = (dx: number, dy: number): [number, number] => {
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) return [0, 0];
      return [-dy / len, dx / len];
    };

    // For each point, compute the left and right offset vertices
    for (let i = 0; i < points.length; i++) {
      const curr = points[i];

      // Get previous and next points (handling endpoints and closed paths)
      let prev: V2d | null = null;
      let next: V2d | null = null;

      if (i > 0) {
        prev = points[i - 1];
      } else if (shouldClose) {
        prev = points[points.length - 1];
      }

      if (i < points.length - 1) {
        next = points[i + 1];
      } else if (shouldClose) {
        next = points[0];
      }

      let nx: number, ny: number;

      if (prev === null && next !== null) {
        // Start point (open path): use direction to next
        const [px, py] = perp(next.x - curr.x, next.y - curr.y);
        nx = px;
        ny = py;
      } else if (next === null && prev !== null) {
        // End point (open path): use direction from prev
        const [px, py] = perp(curr.x - prev.x, curr.y - prev.y);
        nx = px;
        ny = py;
      } else if (prev !== null && next !== null) {
        // Interior point or closed path endpoints: compute miter
        const d1x = curr.x - prev.x;
        const d1y = curr.y - prev.y;
        const d2x = next.x - curr.x;
        const d2y = next.y - curr.y;

        const [n1x, n1y] = perp(d1x, d1y);
        const [n2x, n2y] = perp(d2x, d2y);

        // Miter direction is average of the two normals
        let mx = n1x + n2x;
        let my = n1y + n2y;
        const mLen = Math.sqrt(mx * mx + my * my);

        if (mLen < 0.001) {
          // Nearly parallel lines going in opposite directions
          nx = n1x;
          ny = n1y;
        } else {
          mx /= mLen;
          my /= mLen;

          // Miter length: halfWidth / cos(theta/2) where theta is the angle between normals
          // cos(theta/2) = dot(n1, miter) = n1x*mx + n1y*my
          const cosHalfAngle = n1x * mx + n1y * my;

          // Clamp miter length to avoid spikes at sharp angles (miter limit of 2)
          const miterScale = Math.min(1 / Math.max(cosHalfAngle, 0.5), 2);

          nx = mx * miterScale;
          ny = my * miterScale;
        }
      } else {
        // Single point path (shouldn't happen with length >= 2)
        nx = 1;
        ny = 0;
      }

      // Add left and right vertices
      vertices.push(V(curr.x + nx * halfWidth, curr.y + ny * halfWidth));
      vertices.push(V(curr.x - nx * halfWidth, curr.y - ny * halfWidth));
    }

    // Build triangle strip indices for the line segments
    const segmentCount = shouldClose ? points.length : points.length - 1;
    for (let i = 0; i < segmentCount; i++) {
      const i0 = i * 2;
      const i1 = ((i + 1) % points.length) * 2;

      // Two triangles per segment
      indices.push(i0, i0 + 1, i1);
      indices.push(i0 + 1, i1 + 1, i1);
    }

    if (vertices.length > 0 && indices.length > 0) {
      this.renderer.submitTriangles(vertices, indices, color, alpha);
    }
  }
}

/**
 * High-level drawing API passed to entity onRender callbacks.
 * Provides a clean interface for drawing shapes, images, and paths.
 */
export class Draw {
  constructor(
    /** The underlying WebGL renderer */
    readonly renderer: WebGLRenderer,
    /** The camera for coordinate conversions and zoom */
    readonly camera: Camera2d,
  ) {}

  // ============ Transform Helpers ============

  /**
   * Execute draw commands at a specific position, rotation, and scale.
   * Automatically handles save/restore of transform state.
   *
   * @example
   * draw.at({ pos: this.position, angle: this.rotation }, () => {
   *   draw.rect(-10, -10, 20, 20, { color: 0xFF0000 });
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

  // ============ Shape Drawing ============

  /** Draw a filled rectangle */
  rect(x: number, y: number, w: number, h: number, opts?: DrawOptions): void {
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

  /** Draw a filled circle */
  circle(x: number, y: number, radius: number, opts?: DrawOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1.0;
    const segments = getCircleSegments(radius);

    const vertices: V2d[] = [V(x, y)]; // Center
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      vertices.push(
        V(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius),
      );
    }

    for (let i = 1; i <= segments; i++) {
      indices.push(0, i, i + 1 > segments ? 1 : i + 1);
    }

    this.renderer.submitTriangles(vertices, indices, color, alpha);
  }

  /** Draw a filled polygon */
  polygon(vertices: V2d[], opts?: DrawOptions): void {
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

  // ============ Image Drawing ============

  /** Draw a textured image/sprite */
  image(texture: Texture, x: number, y: number, opts?: ImageOptions): void {
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

  // ============ Path API ============

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

  // ============ Direct Renderer Access ============

  /** Save the current transform state */
  save(): void {
    this.renderer.save();
  }

  /** Restore the previous transform state */
  restore(): void {
    this.renderer.restore();
  }

  /** Translate the current transform */
  translate(x: number, y: number): void;
  translate(pos: V2d): void;
  translate(xOrPos: number | V2d, y?: number): void {
    if (typeof xOrPos === "number") {
      this.renderer.translate(xOrPos, y!);
    } else {
      this.renderer.translate(xOrPos);
    }
  }

  /** Rotate the current transform */
  rotate(radians: number): void {
    this.renderer.rotate(radians);
  }

  /** Scale the current transform */
  scale(s: number): void;
  scale(sx: number, sy: number): void;
  scale(sx: number, sy?: number): void {
    if (sy === undefined) {
      this.renderer.scale(sx, sx);
    } else {
      this.renderer.scale(sx, sy);
    }
  }
}
