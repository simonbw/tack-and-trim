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
  FLOATS_PER_LANDMASS,
} from "../LandMass";

// Constants for terrain data limits
export const MAX_CONTROL_POINTS = 1024;
export const MAX_LANDMASSES = 32;

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
  landMassCount: number;
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
  readonly landMassBuffer: GPUBuffer;

  private landMassCount: number = 0;

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
    //   28-31: landMassCount (u32)
    this.paramsBuffer = device.createBuffer({
      size: 32,
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

    // Land mass metadata storage buffer
    // 8 floats per land mass
    this.landMassBuffer = device.createBuffer({
      size: MAX_LANDMASSES * FLOATS_PER_LANDMASS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Land Mass Buffer",
    });
  }

  /**
   * Upload terrain definition to GPU buffers.
   * Call this when terrain changes (e.g., level loading).
   */
  updateTerrainData(definition: TerrainDefinition): void {
    const device = getWebGPU().device;
    const { controlPointsData, landMassData } = buildTerrainGPUData(definition);

    device.queue.writeBuffer(
      this.controlPointsBuffer,
      0,
      controlPointsData.buffer,
    );
    // landMassData is already an ArrayBuffer (not Float32Array) since it has mixed u32/f32 fields
    device.queue.writeBuffer(this.landMassBuffer, 0, landMassData);
    this.landMassCount = definition.landMasses.length;
  }

  /**
   * Update the params buffer with current frame data.
   */
  updateParams(params: TerrainComputeParams): void {
    const device = getWebGPU().device;

    const paramsData = new ArrayBuffer(32);
    const floats = new Float32Array(paramsData, 0, 7);
    const uints = new Uint32Array(paramsData, 28, 1);

    floats[0] = params.time;
    floats[1] = params.viewportLeft;
    floats[2] = params.viewportTop;
    floats[3] = params.viewportWidth;
    floats[4] = params.viewportHeight;
    floats[5] = params.textureSize;
    floats[6] = params.textureSize;
    uints[0] = params.landMassCount;

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);
  }

  /**
   * Get the current land mass count.
   */
  getLandMassCount(): number {
    return this.landMassCount;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.paramsBuffer.destroy();
    this.controlPointsBuffer.destroy();
    this.landMassBuffer.destroy();
  }
}
