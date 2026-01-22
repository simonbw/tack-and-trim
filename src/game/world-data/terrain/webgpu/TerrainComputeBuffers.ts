/**
 * Shared buffer management for terrain compute shaders.
 *
 * Provides consistent buffer creation and updates for both
 * the rendering pipeline and physics tile pipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import {
  TerrainDefinition,
  buildTerrainGPUData,
  validateTerrainDefinition,
  FLOATS_PER_CONTOUR,
} from "../LandMass";
import { MAX_CONTROL_POINTS, MAX_CONTOURS } from "../TerrainConstants";

/**
 * Parameters for terrain compute shader.
 */
export interface TerrainComputeParams {
  time: number;
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  textureSize: number;
  contourCount: number;
  defaultDepth: number;
}

/**
 * Shared buffer management for terrain compute shaders.
 *
 * Both the rendering pipeline and physics tile pipeline use this
 * to ensure consistent data provision to the GPU shader.
 */
export class TerrainComputeBuffers {
  readonly paramsBuffer: GPUBuffer;
  readonly controlPointsBuffer: GPUBuffer;
  readonly contourBuffer: GPUBuffer;

  private contourCount: number = 0;
  private defaultDepth: number = -50;

  constructor() {
    const device = getWebGPU().device;

    // Params uniform buffer (32 bytes)
    // Layout (byte offsets):
    //   0-3:   time (f32)
    //   4-7:   viewportLeft (f32)
    //   8-11:  viewportTop (f32)
    //   12-15: viewportWidth (f32)
    //   16-19: viewportHeight (f32)
    //   20-23: textureSizeX (f32)
    //   24-27: textureSizeY (f32)
    //   28-31: contourCount (u32)
    //   32-35: defaultDepth (f32)
    //   36-47: padding (for 16-byte alignment)
    this.paramsBuffer = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Terrain Params Buffer",
    });

    // Control points storage buffer
    // vec2<f32> per point = 8 bytes per point
    this.controlPointsBuffer = device.createBuffer({
      size: MAX_CONTROL_POINTS * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Control Points Buffer",
    });

    // Contour metadata storage buffer
    // 6 floats per contour (24 bytes)
    this.contourBuffer = device.createBuffer({
      size: MAX_CONTOURS * FLOATS_PER_CONTOUR * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Contour Buffer",
    });
  }

  /**
   * Upload terrain definition to GPU buffers.
   * Call this when terrain changes (e.g., level loading).
   */
  updateTerrainData(definition: TerrainDefinition): void {
    // Validate terrain definition and log warnings
    validateTerrainDefinition(definition);

    const device = getWebGPU().device;
    const { controlPointsData, contourData, contourCount, defaultDepth } =
      buildTerrainGPUData(definition);

    device.queue.writeBuffer(
      this.controlPointsBuffer,
      0,
      controlPointsData.buffer,
    );
    // contourData is already an ArrayBuffer (not Float32Array) since it has mixed u32/f32 fields
    device.queue.writeBuffer(this.contourBuffer, 0, contourData);
    this.contourCount = contourCount;
    this.defaultDepth = defaultDepth;
  }

  /**
   * Update the params buffer with current frame data.
   */
  updateParams(params: TerrainComputeParams): void {
    const device = getWebGPU().device;

    const paramsData = new ArrayBuffer(48);
    const floats = new Float32Array(paramsData, 0, 8);
    const uints = new Uint32Array(paramsData, 28, 1);
    const floats2 = new Float32Array(paramsData, 32, 1);

    floats[0] = params.time;
    floats[1] = params.viewportLeft;
    floats[2] = params.viewportTop;
    floats[3] = params.viewportWidth;
    floats[4] = params.viewportHeight;
    floats[5] = params.textureSize;
    floats[6] = params.textureSize;
    uints[0] = params.contourCount;
    floats2[0] = params.defaultDepth;

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);
  }

  /**
   * Get the current contour count.
   */
  getContourCount(): number {
    return this.contourCount;
  }

  /**
   * Get the default depth.
   */
  getDefaultDepth(): number {
    return this.defaultDepth;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.paramsBuffer.destroy();
    this.controlPointsBuffer.destroy();
    this.contourBuffer.destroy();
  }
}
