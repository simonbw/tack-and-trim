import { V, V2d } from "../Vector";
import { Camera2d } from "./Camera2d";
import { PathBuilder } from "./PathBuilder";
import { Texture } from "./TextureManager";
import { WebGLRenderer } from "./WebGLRenderer";

// Re-export PathBuilder for convenience
export { PathBuilder };

// Number of circle segments based on radius
function getCircleSegments(radius: number): number {
  return Math.max(16, Math.min(64, Math.floor(radius * 4)));
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
