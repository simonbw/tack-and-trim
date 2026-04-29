/**
 * Renders a cloth sail mesh with cel-shaded lighting via a custom GPU pipeline.
 *
 * Computes per-vertex normals (averaged face normals) on the CPU, then
 * submits positions + normals to the SailShader for per-fragment lighting
 * with discrete tone quantization.
 */

import type { Draw } from "../../../core/graphics/Draw";
import type { WeatherState } from "../../weather/WeatherState";
import { SailShaderInstance, SAIL_VERTEX_SIZE } from "./SailShader";

/** Minimal interface for reading cloth vertex positions. */
export interface ClothPositionReader {
  getPositionX(i: number): number;
  getPositionY(i: number): number;
  getZ(i: number): number;
}

export class ClothRenderer {
  /** Pre-allocated vertex data: [px, py, nx, ny, nz] per vertex. */
  private readonly vertexData: Float32Array;
  /** Pre-allocated index data. */
  private readonly indexData: Uint16Array;
  /** Pre-allocated normal accumulation buffer. */
  private readonly normalAccum: Float32Array;
  private readonly vertexCount: number;
  private readonly indexCount: number;
  private readonly indices: number[];
  private readonly shaderInstance: SailShaderInstance;

  constructor(vertexCount: number, indices: number[]) {
    this.vertexCount = vertexCount;
    this.indices = indices;
    this.indexCount = indices.length;
    this.vertexData = new Float32Array(vertexCount * SAIL_VERTEX_SIZE);
    this.normalAccum = new Float32Array(vertexCount * 3);

    // Pre-fill index buffer (indices never change)
    // Allocate padded to even count so writeBuffer gets a 4-byte-multiple size
    const paddedLen = (indices.length + 1) & ~1;
    this.indexData = new Uint16Array(paddedLen);
    for (let i = 0; i < indices.length; i++) {
      this.indexData[i] = indices[i];
    }

    this.shaderInstance = new SailShaderInstance(vertexCount, paddedLen);
  }

  /**
   * Read solver positions (already in heeled world space), compute normals,
   * and submit for rendering.
   *
   * @param vertexActive Optional per-vertex active mask. If provided, triangles
   *   with any inactive vertex are skipped.
   */
  render(
    solver: ClothPositionReader,
    draw: Draw,
    color: number,
    alpha: number,
    weather: WeatherState | null,
    vertexActive?: Uint8Array,
  ): void {
    const n = this.vertexCount;
    const verts = this.vertexData;
    const normals = this.normalAccum;
    const indices = this.indices;

    // Clear normals
    normals.fill(0);

    // Solver positions are already in heeled world space — read directly
    for (let i = 0; i < n; i++) {
      const vi = i * SAIL_VERTEX_SIZE;
      verts[vi] = solver.getPositionX(i);
      verts[vi + 1] = solver.getPositionY(i);
      // normal slots (vi+2, vi+3, vi+4) filled below
      verts[vi + 5] = solver.getZ(i); // world z-height for depth testing
    }

    // Build index buffer, skipping inactive triangles
    let activeIndexCount = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];

      // Skip triangles with any inactive vertex
      if (
        vertexActive &&
        (!vertexActive[i0] || !vertexActive[i1] || !vertexActive[i2])
      )
        continue;

      const x0 = solver.getPositionX(i0),
        y0 = solver.getPositionY(i0),
        z0 = solver.getZ(i0);
      const x1 = solver.getPositionX(i1),
        y1 = solver.getPositionY(i1),
        z1 = solver.getZ(i1);
      const x2 = solver.getPositionX(i2),
        y2 = solver.getPositionY(i2),
        z2 = solver.getZ(i2);

      const e1x = x1 - x0,
        e1y = y1 - y0,
        e1z = z1 - z0;
      const e2x = x2 - x0,
        e2y = y2 - y0,
        e2z = z2 - z0;

      // Cross product (area-weighted face normal)
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      normals[i0 * 3] += nx;
      normals[i0 * 3 + 1] += ny;
      normals[i0 * 3 + 2] += nz;
      normals[i1 * 3] += nx;
      normals[i1 * 3 + 1] += ny;
      normals[i1 * 3 + 2] += nz;
      normals[i2 * 3] += nx;
      normals[i2 * 3 + 1] += ny;
      normals[i2 * 3 + 2] += nz;

      // Write to index buffer
      this.indexData[activeIndexCount] = i0;
      this.indexData[activeIndexCount + 1] = i1;
      this.indexData[activeIndexCount + 2] = i2;
      activeIndexCount += 3;
    }

    if (activeIndexCount === 0) return;

    // Write normalized normals into vertex buffer
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let nx = normals[i3],
        ny = normals[i3 + 1],
        nz = normals[i3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0.0001) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = 0;
        ny = 0;
        nz = 1;
      }
      const vi = i * SAIL_VERTEX_SIZE;
      verts[vi + 2] = nx;
      verts[vi + 3] = ny;
      verts[vi + 4] = nz;
    }

    // Flush pending batches so our custom draw doesn't disrupt layer ordering
    draw.renderer.flush();

    // Draw with custom sail shader
    this.shaderInstance.draw(
      draw.renderer,
      verts,
      n,
      this.indexData,
      activeIndexCount,
      color,
      alpha,
      weather,
    );
  }

  /** Clean up GPU resources. */
  destroy(): void {
    this.shaderInstance.destroy();
  }
}
