/**
 * Terrain GPU resource manager.
 *
 * Owns and manages GPU buffers for terrain contour data.
 * Provides read-only access to buffers for query shaders and render pipelines.
 * Also stores the terrain definition and tracks version changes.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import {
  type TerrainContour,
  type TerrainDefinition,
  buildTerrainGPUData,
  FLOATS_PER_CONTOUR,
  normalizeTerrainWinding,
} from "./LandMass";
import { MAX_CHILDREN, MAX_CONTOURS, MAX_VERTICES } from "./TerrainConstants";

/**
 * Manages GPU resources for terrain data.
 *
 * Resource provider that owns GPU buffers and provides access to them.
 * Also stores the terrain definition for CPU access and tracks version changes.
 */
export class TerrainResources extends BaseEntity {
  id = "terrainResources";

  // GPU buffers
  readonly vertexBuffer: GPUBuffer;
  readonly contourBuffer: GPUBuffer;
  readonly childrenBuffer: GPUBuffer;

  // Terrain definition (normalized to CCW winding)
  private terrainDefinition: TerrainDefinition;

  // Version number - increments when terrain changes
  private version: number = 0;

  private contourCount: number = 0;

  constructor(terrainDefinition: TerrainDefinition) {
    super();

    // Normalize contour winding to CCW for consistent wave physics
    this.terrainDefinition = normalizeTerrainWinding(terrainDefinition);

    const device = getWebGPU().device;

    // Create GPU buffers
    this.vertexBuffer = device.createBuffer({
      size: MAX_VERTICES * 2 * 4, // vec2<f32> per pre-sampled vertex
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Vertex Buffer",
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
    this.uploadTerrainData(this.terrainDefinition);
  }

  @on("destroy")
  onDestroy(): void {
    this.vertexBuffer.destroy();
    this.contourBuffer.destroy();
    this.childrenBuffer.destroy();
  }

  /**
   * Upload terrain data to GPU buffers.
   * @internal
   */
  private uploadTerrainData(definition: TerrainDefinition): void {
    const device = getWebGPU().device;
    const { vertexData, contourData, childrenData, contourCount } =
      buildTerrainGPUData(definition);

    device.queue.writeBuffer(this.vertexBuffer, 0, vertexData.buffer);
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

  /**
   * Get all contours (read-only).
   */
  getContours(): readonly TerrainContour[] {
    return this.terrainDefinition.contours;
  }

  /**
   * Get the full terrain definition.
   */
  getTerrainDefinition(): TerrainDefinition {
    return this.terrainDefinition;
  }

  /**
   * Update the terrain definition (e.g., for level loading or editor changes).
   * Normalizes contour winding to CCW for consistent wave physics.
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.terrainDefinition = normalizeTerrainWinding(definition);
    this.uploadTerrainData(this.terrainDefinition);
    this.version++;
  }

  /**
   * Get the terrain definition version.
   * Increments whenever terrain data changes.
   */
  getVersion(): number {
    return this.version;
  }
}
