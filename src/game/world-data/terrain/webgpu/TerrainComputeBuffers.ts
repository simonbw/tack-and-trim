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
import {
  MAX_CONTROL_POINTS,
  MAX_CONTOURS,
  MAX_CHILDREN,
} from "../TerrainConstants";

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
  maxDepth: number;
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
  readonly childrenBuffer: GPUBuffer;

  private contourCount: number = 0;
  private maxDepth: number = 0;
  private defaultDepth: number = -50;

  constructor() {
    const device = getWebGPU().device;

    // Params uniform buffer (48 bytes)
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
    //   36-39: maxDepth (u32)
    //   40-47: padding (for 16-byte alignment)
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
    // 9 values per contour (36 bytes each)
    // Layout per contour:
    //   0-3:   pointStartIndex (u32)
    //   4-7:   pointCount (u32)
    //   8-11:  height (f32)
    //   12-15: parentIndex (i32, -1 if root)
    //   16-19: depth (u32)
    //   20-23: childStartIndex (u32)
    //   24-27: childCount (u32)
    //   28-35: padding (for 16-byte struct alignment)
    this.contourBuffer = device.createBuffer({
      size: MAX_CONTOURS * FLOATS_PER_CONTOUR * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Contour Buffer",
    });

    // Children indices storage buffer (flat array of u32)
    this.childrenBuffer = device.createBuffer({
      size: MAX_CHILDREN * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Children Buffer",
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
    const {
      controlPointsData,
      contourData,
      childrenData,
      contourCount,
      maxDepth,
      defaultDepth,
    } = buildTerrainGPUData(definition);

    device.queue.writeBuffer(
      this.controlPointsBuffer,
      0,
      controlPointsData.buffer,
    );
    // contourData is already an ArrayBuffer (not Float32Array) since it has mixed u32/f32 fields
    device.queue.writeBuffer(this.contourBuffer, 0, contourData);
    // Upload children indices
    if (childrenData.length > 0) {
      device.queue.writeBuffer(this.childrenBuffer, 0, childrenData.buffer);
    }
    this.contourCount = contourCount;
    this.maxDepth = maxDepth;
    this.defaultDepth = defaultDepth;
  }

  /**
   * Update the params buffer with current frame data.
   */
  updateParams(params: TerrainComputeParams): void {
    const device = getWebGPU().device;

    const paramsData = new ArrayBuffer(48);
    const view = new DataView(paramsData);

    view.setFloat32(0, params.time, true);
    view.setFloat32(4, params.viewportLeft, true);
    view.setFloat32(8, params.viewportTop, true);
    view.setFloat32(12, params.viewportWidth, true);
    view.setFloat32(16, params.viewportHeight, true);
    view.setFloat32(20, params.textureSize, true);
    view.setFloat32(24, params.textureSize, true);
    view.setUint32(28, params.contourCount, true);
    view.setFloat32(32, params.defaultDepth, true);
    view.setUint32(36, params.maxDepth, true);
    // bytes 40-47 are padding

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);
  }

  /**
   * Get the current contour count.
   */
  getContourCount(): number {
    return this.contourCount;
  }

  /**
   * Get the maximum tree depth.
   */
  getMaxDepth(): number {
    return this.maxDepth;
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
    this.childrenBuffer.destroy();
  }
}
