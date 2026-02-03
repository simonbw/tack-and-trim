/**
 * Terrain GPU resource manager.
 *
 * Owns and manages GPU buffers for terrain contour data.
 * Provides read-only access to buffers for query shaders and render pipelines.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  type TerrainDefinition,
  buildTerrainGPUData,
  FLOATS_PER_CONTOUR,
} from "../../world-data/terrain/LandMass";
import {
  MAX_CHILDREN,
  MAX_CONTOURS,
  MAX_CONTROL_POINTS,
} from "../../world-data/terrain/TerrainConstants";

/**
 * Manages GPU resources for terrain data.
 *
 * Simple resource provider that owns GPU buffers and provides access to them.
 * Does not do any computation itself.
 */
export class TerrainResources extends BaseEntity {
  id = "terrainResources";

  // GPU buffers
  readonly controlPointsBuffer: GPUBuffer;
  readonly contourBuffer: GPUBuffer;
  readonly childrenBuffer: GPUBuffer;

  private contourCount: number = 0;

  constructor(terrainDefinition: TerrainDefinition) {
    super();

    const device = getWebGPU().device;

    // Create GPU buffers
    this.controlPointsBuffer = device.createBuffer({
      size: MAX_CONTROL_POINTS * 2 * 4, // vec2<f32> per point
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Control Points Buffer",
    });

    this.contourBuffer = device.createBuffer({
      size: MAX_CONTOURS * FLOATS_PER_CONTOUR * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Contour Buffer",
    });

    this.childrenBuffer = device.createBuffer({
      size: MAX_CHILDREN * 4, // u32 per child index
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Children Buffer",
    });

    // Upload initial terrain data
    this.updateTerrainData(terrainDefinition);
  }

  @on("destroy")
  onDestroy(): void {
    this.controlPointsBuffer.destroy();
    this.contourBuffer.destroy();
    this.childrenBuffer.destroy();
  }

  /**
   * Update terrain data (e.g., when loading a new level).
   */
  updateTerrainData(definition: TerrainDefinition): void {
    const device = getWebGPU().device;
    const { controlPointsData, contourData, childrenData, contourCount } =
      buildTerrainGPUData(definition);

    device.queue.writeBuffer(
      this.controlPointsBuffer,
      0,
      controlPointsData.buffer,
    );
    device.queue.writeBuffer(this.contourBuffer, 0, contourData);
    if (childrenData.length > 0) {
      device.queue.writeBuffer(this.childrenBuffer, 0, childrenData.buffer);
    }

    this.contourCount = contourCount;
  }

  /**
   * Get the number of contours.
   */
  getContourCount(): number {
    return this.contourCount;
  }
}
