/**
 * Shared buffer management for terrain compute shaders.
 *
 * Provides consistent buffer creation and updates for both
 * the rendering pipeline and physics tile pipeline.
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import {
  defineUniformStruct,
  f32,
  u32,
  type UniformInstance,
} from "../../../../core/graphics/UniformStruct";
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

// Type-safe params buffer definition - single source of truth for shader struct
export const TerrainParams = defineUniformStruct("Params", {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  contourCount: u32,
  defaultDepth: f32,
  maxDepth: u32,
  // Padding to 48 bytes (12 floats) for 16-byte alignment
  _padding1: f32,
  _padding2: f32,
});

/**
 * Parameters for terrain compute shader.
 */
export interface TerrainComputeParams {
  time: number;
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  textureSizeX: number;
  textureSizeY: number;
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

  private params!: UniformInstance<typeof TerrainParams.fields>;
  private contourCount: number = 0;
  private maxDepth: number = 0;
  private defaultDepth: number = -50;

  constructor() {
    const device = getWebGPU().device;

    // Create type-safe params instance
    this.params = TerrainParams.create();

    // Params uniform buffer
    this.paramsBuffer = device.createBuffer({
      size: TerrainParams.byteSize,
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
  updateParams(input: TerrainComputeParams): void {
    // Use type-safe setters
    this.params.set.time(input.time);
    this.params.set.viewportLeft(input.viewportLeft);
    this.params.set.viewportTop(input.viewportTop);
    this.params.set.viewportWidth(input.viewportWidth);
    this.params.set.viewportHeight(input.viewportHeight);
    this.params.set.textureSizeX(input.textureSizeX);
    this.params.set.textureSizeY(input.textureSizeY);
    this.params.set.contourCount(input.contourCount);
    this.params.set.defaultDepth(input.defaultDepth);
    this.params.set.maxDepth(input.maxDepth);
    this.params.set._padding1(0);
    this.params.set._padding2(0);

    // Upload to GPU
    this.params.uploadTo(this.paramsBuffer);
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
