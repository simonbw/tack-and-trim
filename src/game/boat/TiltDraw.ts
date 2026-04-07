/**
 * Drawing helper for rendering geometry inside a 3D tilt context.
 *
 * Wraps the screen-width tessellation functions and renderer submission into
 * a concise API. Lines, polylines, and circles maintain constant screen-space
 * width regardless of the boat's roll, pitch, and yaw.
 *
 * Usage:
 *   const td = new TiltDraw(draw.renderer, tilt);
 *   td.line(x1, y1, z1, x2, y2, z2, 0.4, color, 1, true);
 */

import type { WebGPURenderer } from "../../core/graphics/webgpu/WebGPURenderer";
import {
  type MeshContribution,
  type TiltProjection,
  tessellateScreenCircle,
  tessellateScreenWidthLine,
  tessellateScreenWidthPolyline,
} from "./tessellation";

export { type MeshContribution, type TiltProjection };

export class TiltDraw {
  constructor(
    private renderer: WebGPURenderer,
    private tilt: TiltProjection,
  ) {}

  /** Submit pre-built mesh geometry (hull, keel, deck plan zones, etc.). */
  mesh(mesh: MeshContribution | null): void {
    if (!mesh || mesh.indices.length === 0) return;
    this.renderer.submitTrianglesWithZ(
      mesh.positions,
      mesh.indices,
      mesh.color,
      mesh.alpha,
      mesh.zValues,
    );
  }

  /** Cylindrical line with constant screen width and optional round caps. */
  line(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    width: number,
    color: number,
    alpha: number = 1,
    roundCaps: boolean = false,
  ): void {
    this.mesh(
      tessellateScreenWidthLine(
        x1,
        y1,
        z1,
        x2,
        y2,
        z2,
        width,
        this.tilt,
        color,
        alpha,
        roundCaps,
      ),
    );
  }

  /**
   * Polyline with constant screen width.
   * @param closed — Join first and last points (default false).
   * @param roundJoins — Use rounded joins and end caps (default false).
   */
  polyline(
    points: [number, number][],
    zValues: number[],
    width: number,
    color: number,
    alpha: number = 1,
    closed: boolean = false,
    roundJoins: boolean = false,
  ): void {
    this.mesh(
      tessellateScreenWidthPolyline(
        points,
        zValues,
        width,
        this.tilt,
        color,
        alpha,
        closed,
        roundJoins,
      ),
    );
  }

  /** Filled circle with constant screen radius. */
  circle(
    x: number,
    y: number,
    z: number,
    radius: number,
    segments: number,
    color: number,
    alpha: number = 1,
  ): void {
    this.mesh(
      tessellateScreenCircle(
        x,
        y,
        z,
        radius,
        segments,
        this.tilt,
        color,
        alpha,
      ),
    );
  }
}
