import { V2d } from "../Vector";
import { Camera2d } from "./Camera2d";
import { Texture } from "./TextureManager";
import { WebGLRenderer, DrawOptions, LineOptions } from "./WebGLRenderer";

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

/** Options for the at() transform helper */
export interface AtOptions {
  pos: V2d;
  angle?: number;
  scale?: number | V2d;
}

// Re-export types from WebGLRenderer for convenience
export type { DrawOptions, LineOptions };

/**
 * Fluent path builder for complex shapes.
 */
export class PathBuilder {
  constructor(private renderer: WebGLRenderer) {
    renderer.beginPath();
  }

  /** Move to a point without drawing */
  moveTo(x: number, y: number): this {
    this.renderer.moveTo(x, y);
    return this;
  }

  /** Draw a line to a point */
  lineTo(x: number, y: number): this {
    this.renderer.lineTo(x, y);
    return this;
  }

  /** Draw a quadratic curve */
  quadraticTo(cpx: number, cpy: number, x: number, y: number): this {
    this.renderer.quadraticCurveTo(cpx, cpy, x, y);
    return this;
  }

  /** Close the path back to the starting point */
  close(): this {
    this.renderer.closePath();
    return this;
  }

  /** Fill the path with a color */
  fill(color: number, alpha: number = 1): void {
    this.renderer.fill(color, alpha);
  }

  /** Stroke the path outline */
  stroke(color: number, width: number = 1, alpha: number = 1): void {
    this.renderer.stroke(color, width, alpha, false);
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
  at(opts: AtOptions, draw: () => void): void {
    const { pos, angle, scale } = opts;

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
    this.renderer.drawRect(x, y, w, h, opts);
  }

  /** Draw a filled circle */
  circle(x: number, y: number, radius: number, opts?: DrawOptions): void {
    this.renderer.drawCircle(x, y, radius, opts);
  }

  /** Draw a filled polygon */
  polygon(vertices: V2d[], opts?: DrawOptions): void {
    this.renderer.drawPolygon(vertices, opts);
  }

  /** Draw a line (world-space width - scales with zoom) */
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: LineOptions,
  ): void {
    this.renderer.drawLine(x1, y1, x2, y2, opts);
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
    this.renderer.drawLine(x1, y1, x2, y2, adjustedOpts);
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
