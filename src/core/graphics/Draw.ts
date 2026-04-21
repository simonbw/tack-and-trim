import { clamp } from "../util/MathUtil";
import { V2d } from "../Vector";
import { Camera2d } from "./Camera2d";
import { CachedMesh } from "./CachedMesh";
import { DynamicMesh } from "./DynamicMesh";
import { PathBuilder } from "./PathBuilder";
import { tessellateCircle } from "./tessellation/circle";
import { tessellateLine, tessellateScreenLine } from "./tessellation/line";
import {
  tessellateScreenPolyline,
  tessellateWorldPolyline,
} from "./tessellation/polyline";
import {
  tessellateFillPolygon,
  tessellateStrokePolygon,
} from "./tessellation/polygon";
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
import { tessellateRect } from "./tessellation/rectangle";
import { computeTiltProjection } from "./TiltProjection";
import { WebGPURenderer } from "./webgpu/WebGPURenderer";
import { WebGPUTexture } from "./webgpu/WebGPUTextureManager";

// Re-export PathBuilder for convenience
export { PathBuilder };

const MIN_CIRCLE_SEGMENTS = 4;
const MAX_CIRCLE_SEGMENTS = 64;

function getCircleSegments(radius: number): number {
  return clamp(
    Math.floor(radius * 4),
    MIN_CIRCLE_SEGMENTS,
    MAX_CIRCLE_SEGMENTS,
  );
}

/** Options for shape drawing */
export interface DrawOptions {
  color?: number; // 0xRRGGBB
  alpha?: number; // 0-1
  /** Z-height for depth testing. Only meaningful inside a tilt context or on a depth-enabled layer. */
  z?: number;
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
      tilt,
    }: {
      pos: V2d;
      angle?: number;
      scale?: number | V2d;
      /** When provided, sets up a 3D tilt projection context.
       * The model matrix uses the full Yaw·Pitch·Roll rotation so that
       * body-local (x, y) coordinates with per-vertex z are correctly
       * projected to 2D AND write accurate depth to the depth buffer.
       * zOffset (typically bb.z) is added to currentZ so all setZ()
       * calls within the context automatically include the boat's
       * vertical position. */
      tilt?: { roll: number; pitch: number; zOffset?: number };
    },
    draw: () => void,
  ): void {
    this.renderer.save();
    const prevTilt = this.renderer.getCurrentTilt();

    if (tilt) {
      const cam = this.renderer.getTransform();

      const a = angle ?? 0;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const sr = Math.sin(tilt.roll);
      const sp = Math.sin(tilt.pitch);
      const cr = Math.cos(tilt.roll);
      const cp = Math.cos(tilt.pitch);

      const r00 = ca * cp;
      const r10 = sa * cp;
      const r01 = ca * sp * sr - sa * cr;
      const r11 = sa * sp * sr + ca * cr;

      const px = pos.x;
      const py = pos.y;
      const m = this.renderer.getTransform();
      m.a = cam.a * r00 + cam.c * r10;
      m.b = cam.b * r00 + cam.d * r10;
      m.c = cam.a * r01 + cam.c * r11;
      m.d = cam.b * r01 + cam.d * r11;
      m.tx = cam.a * px + cam.c * py + cam.tx;
      m.ty = cam.b * px + cam.d * py + cam.ty;
      this.renderer.setTransform(m);

      const worldZX = -(ca * sp * cr + sa * sr);
      const worldZY = -(sa * sp * cr - ca * sr);

      this.renderer.setZCoeffs(
        cam.a * worldZX + cam.c * worldZY,
        cam.b * worldZX + cam.d * worldZY,
      );

      this.renderer.setZRow(sp, -(cp * sr), cp * cr);

      if (tilt.zOffset !== undefined) {
        this.renderer.setZ(tilt.zOffset);
      }

      // Make the local-space tilt projection available to screenLine /
      // screenCircle / etc. Uses the same angle+roll+pitch.
      this.renderer.setCurrentTilt(
        computeTiltProjection(a, tilt.roll, tilt.pitch),
      );
    } else {
      this.renderer.translate(pos);

      if (angle !== undefined) {
        this.renderer.rotate(angle);
      }
    }

    if (scale !== undefined) {
      if (typeof scale === "number") {
        this.renderer.scale(scale, scale);
      } else {
        this.renderer.scale(scale.x, scale.y);
      }
    }

    draw();

    this.renderer.setCurrentTilt(prevTilt);
    this.renderer.restore();
  }

  /** Submit a cached or dynamic mesh. */
  mesh(m: CachedMesh | DynamicMesh): void {
    this.renderer.drawMesh(m);
  }

  /**
   * Temporarily override the renderer's z for a single primitive. The
   * tessellator emits per-vertex z = 0, so the final depth comes from the
   * transform's zBase; this keeps the old `opts.z`-as-absolute semantics
   * without double-applying the current z.
   */
  private applyZ(z: number | undefined): number {
    const prev = this.renderer.getZ();
    if (z !== undefined) this.renderer.setZ(z);
    return prev;
  }

  // ============ Fills ============

  /** Draw a filled rectangle */
  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: DrawOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const prevZ = this.applyZ(opts?.z);
    tessellateRect(
      this.renderer.prepareShapeSink(),
      x,
      y,
      w,
      h,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a filled circle */
  fillCircle(x: number, y: number, radius: number, opts?: CircleOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const radiusOnScreen = radius * this.renderer.getCurrentScale();
    const segments = opts?.segments ?? getCircleSegments(radiusOnScreen);
    const prevZ = this.applyZ(opts?.z);
    tessellateCircle(
      this.renderer.prepareShapeSink(),
      x,
      y,
      radius,
      segments,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a filled polygon (supports concave polygons) */
  fillPolygon(vertices: V2d[], opts?: DrawOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const prevZ = this.applyZ(opts?.z);
    tessellateFillPolygon(
      this.renderer.prepareShapeSink(),
      vertices,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a filled triangle */
  fillTriangle(
    v1: V2d | { x: number; y: number },
    v2: V2d | { x: number; y: number },
    v3: V2d | { x: number; y: number },
    opts?: DrawOptions,
  ): void {
    this.fillPolygon(
      [
        { x: v1.x, y: v1.y } as V2d,
        { x: v2.x, y: v2.y } as V2d,
        { x: v3.x, y: v3.y } as V2d,
      ],
      opts,
    );
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
    const vertices = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
    this.fillRoundedPolygon(vertices as V2d[], radius, opts);
  }

  /** Draw a filled polygon with rounded corners */
  fillRoundedPolygon(
    vertices: V2d[],
    radius: number,
    opts?: DrawOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const prevZ = this.applyZ(opts?.z);
    tessellateFillRoundedPolygon(
      this.renderer.prepareShapeSink(),
      vertices,
      radius,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a filled smooth polygon (Catmull-Rom through the control points). */
  fillSmoothPolygon(vertices: V2d[], opts?: SmoothOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const tension = opts?.tension ?? 0.5;
    const prevZ = this.applyZ(opts?.z);
    tessellateFillSmoothPolygon(
      this.renderer.prepareShapeSink(),
      vertices,
      tension,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  // ============ Strokes ============

  /** Draw a stroked rectangle outline */
  strokeRect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: LineOptions,
  ): void {
    this.strokePolygon(
      [
        { x, y } as V2d,
        { x: x + w, y } as V2d,
        { x: x + w, y: y + h } as V2d,
        { x, y: y + h } as V2d,
      ],
      opts,
    );
  }

  /** Draw a stroked circle outline (miter-jointed polyline). */
  strokeCircle(x: number, y: number, radius: number, opts?: LineOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const segments = getCircleSegments(radius);
    const points: [number, number][] = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push([x + Math.cos(angle) * radius, y + Math.sin(angle) * radius]);
    }
    const prevZ = this.applyZ(opts?.z);
    tessellateWorldPolyline(
      this.renderer.prepareShapeSink(),
      points,
      0,
      width,
      color,
      alpha,
      { closed: true },
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a stroked polygon outline (closed) */
  strokePolygon(vertices: V2d[], opts?: LineOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const prevZ = this.applyZ(opts?.z);
    tessellateStrokePolygon(
      this.renderer.prepareShapeSink(),
      vertices,
      width,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
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
    const vertices = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
    this.strokeRoundedPolygon(vertices as V2d[], radius, opts);
  }

  /** Draw a stroked polygon with rounded corners */
  strokeRoundedPolygon(
    vertices: V2d[],
    radius: number,
    opts?: LineOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const prevZ = this.applyZ(opts?.z);
    tessellateStrokeRoundedPolygon(
      this.renderer.prepareShapeSink(),
      vertices,
      radius,
      width,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a stroked smooth polygon (Catmull-Rom). */
  strokeSmoothPolygon(
    vertices: V2d[],
    opts?: SmoothOptions & LineOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const tension = opts?.tension ?? 0.5;
    const prevZ = this.applyZ(opts?.z);
    tessellateStrokeSmoothPolygon(
      this.renderer.prepareShapeSink(),
      vertices,
      tension,
      width,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /** Draw a smooth open curve (spline) through the given points */
  spline(vertices: V2d[], opts?: SplineOptions): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const tension = opts?.tension ?? 0.5;
    const prevZ = this.applyZ(opts?.z);
    tessellateSpline(
      this.renderer.prepareShapeSink(),
      vertices,
      tension,
      width,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  // ============ Lines ============

  /** Draw a line (world-space width - scales with zoom) */
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: LineOptions,
  ): void {
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const prevZ = this.applyZ(opts?.z);
    tessellateLine(
      this.renderer.prepareShapeSink(),
      x1,
      y1,
      x2,
      y2,
      width,
      color,
      alpha,
      0,
    );
    this.renderer.setZ(prevZ);
  }

  /**
   * Draw a line with screen-space width (constant pixel width regardless of zoom).
   * If a tilt context is active, uses tilt-aware screen-width math; otherwise
   * scales the world-width by the camera zoom.
   */
  screenLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: LineOptions,
  ): void {
    const tilt = this.renderer.getCurrentTilt();
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    const width = opts?.width ?? 1;
    const z = opts?.z ?? this.renderer.getZ();
    if (tilt) {
      tessellateScreenLine(
        this.renderer.prepareShapeSink(),
        x1,
        y1,
        z,
        x2,
        y2,
        z,
        width,
        tilt,
        color,
        alpha,
      );
    } else {
      tessellateLine(
        this.renderer.prepareShapeSink(),
        x1,
        y1,
        x2,
        y2,
        width / this.camera.z,
        color,
        alpha,
        z,
      );
    }
  }

  /**
   * Screen-width polyline with per-vertex z. Requires an active tilt context.
   */
  screenPolyline(
    points: ReadonlyArray<readonly [number, number]>,
    zPerPoint: ReadonlyArray<number>,
    width: number,
    opts?: {
      color?: number;
      alpha?: number;
      closed?: boolean;
      roundCaps?: boolean;
    },
  ): void {
    const tilt = this.renderer.getCurrentTilt();
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    if (!tilt) {
      // Fallback: treat as world-width polyline at mean z.
      tessellateWorldPolyline(
        this.renderer.prepareShapeSink(),
        points,
        zPerPoint,
        width / this.camera.z,
        color,
        alpha,
        { closed: opts?.closed, roundCaps: opts?.roundCaps },
      );
      return;
    }
    tessellateScreenPolyline(
      this.renderer.prepareShapeSink(),
      points,
      zPerPoint,
      width,
      tilt,
      color,
      alpha,
      { closed: opts?.closed, roundCaps: opts?.roundCaps },
    );
  }

  /** Tilt-aware screen-width circle (stays circular on screen under tilt). */
  screenCircle(
    x: number,
    y: number,
    z: number,
    radius: number,
    segments: number,
    opts?: { color?: number; alpha?: number },
  ): void {
    const tilt = this.renderer.getCurrentTilt();
    const color = opts?.color ?? 0xffffff;
    const alpha = opts?.alpha ?? 1;
    if (!tilt) {
      tessellateCircle(
        this.renderer.prepareShapeSink(),
        x,
        y,
        radius,
        segments,
        color,
        alpha,
        z,
      );
      return;
    }
    tessellateScreenCircle(
      this.renderer.prepareShapeSink(),
      x,
      y,
      z,
      radius,
      segments,
      tilt,
      color,
      alpha,
    );
  }

  // ============ Sprites ============

  /** Draw a textured image/sprite */
  image(
    texture: WebGPUTexture,
    x: number,
    y: number,
    opts?: ImageOptions,
  ): void {
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

  // ============ Paths ============

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
}
