/**
 * Wave Physics Manager
 *
 * Manages analytical wave physics computation:
 * - Computes terrain bounds for mesh building domain
 * - Coordinates worker-based wavefront mesh building
 * - Provides packed mesh data buffer for GPU shaders
 */

import type { TerrainDefinition } from "../world/terrain/LandMass";
import type { TerrainCPUData } from "../world/terrain/TerrainCPUData";
import type { WaveSource } from "../world/water/WaveSource";
import {
  buildPackedMeshBuffer,
  createPlaceholderPackedMeshBuffer,
} from "./MeshPacking";
import type { WavefrontMesh } from "./WavefrontMesh";
import { WavefrontRasterizer } from "./WavefrontRasterizer";
import { MeshBuildCoordinator } from "./mesh-building/MeshBuildCoordinator";
import type {
  MeshBuildBounds,
  MeshBuilderType,
} from "./mesh-building/MeshBuildTypes";

/** Maximum number of wave sources for mesh computation */
export const MAX_WAVE_SOURCES = 8;

/**
 * Compute axis-aligned bounding box covering all terrain contours.
 * Iterates sampled polygon vertices to find the full terrain extent.
 */
function computeTerrainBounds(
  terrainDef: TerrainDefinition,
): MeshBuildBounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let hasAnyContour = false;

  for (const contour of terrainDef.contours) {
    for (const pt of contour.sampledPolygon) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
      hasAnyContour = true;
    }
  }

  if (!hasAnyContour) return null;
  return { minX, maxX, minY, maxY };
}

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Builds wavefront meshes for per-wave energy, direction, and phase correction.
 */
export class WavePhysicsManager {
  /** Wavefront meshes organized by builder type */
  private meshSets = new Map<MeshBuilderType, WavefrontMesh[]>();

  /** Coordinator for worker-based mesh building */
  private meshCoordinator: MeshBuildCoordinator;

  /** Active builder types to build meshes for */
  private activeBuilderTypes: MeshBuilderType[] = ["marching"];

  /** Currently selected builder type for rendering/queries */
  private activeBuilderType: MeshBuilderType = "marching";

  /** Packed mesh buffer for query shader lookup */
  private packedMeshBuffer: GPUBuffer | null = null;

  /** Rasterizer for rendering meshes to screen-space texture */
  private rasterizer: WavefrontRasterizer;

  /** Whether the manager has been initialized with terrain */
  private initialized = false;

  private device: GPUDevice;
  private waveSources: WaveSource[];

  /**
   * Create a WavePhysicsManager.
   * @param device - GPU device for creating GPU resources
   * @param waveSources - Wave source configurations
   */
  constructor(device: GPUDevice, waveSources: WaveSource[] = []) {
    this.device = device;
    this.waveSources = waveSources;
    this.meshCoordinator = new MeshBuildCoordinator(this.device);
    this.rasterizer = new WavefrontRasterizer(this.device);
  }

  /**
   * Initialize the wave physics manager with terrain data.
   * Computes wavefront meshes for each wave source.
   *
   * @param terrainDef - Terrain definition for terrain bounds extraction
   * @param terrainGPUData - Raw typed arrays from buildTerrainCPUData() (for worker mesh builds)
   * @param tideHeight - Current tide height
   */
  async initialize(
    terrainDef: TerrainDefinition,
    terrainGPUData?: TerrainCPUData,
    tideHeight?: number,
  ): Promise<void> {
    // Initialize rasterizer
    await this.rasterizer.init();

    // Build wavefront meshes via workers if terrain data is available
    if (terrainGPUData && tideHeight !== undefined) {
      const terrainBounds = computeTerrainBounds(terrainDef);
      await this.meshCoordinator.initialize();
      this.meshSets = await this.meshCoordinator.buildMeshes(
        this.waveSources,
        terrainGPUData,
        terrainBounds,
        tideHeight,
        this.activeBuilderTypes,
      );
    }

    // Build packed mesh buffer for query shader
    this.rebuildPackedMeshBuffer();

    this.initialized = true;
  }

  /**
   * Check if the manager is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get meshes for a specific builder type, or the first available type.
   */
  getMeshes(builderType?: MeshBuilderType): readonly WavefrontMesh[] {
    if (builderType) {
      return this.meshSets.get(builderType) ?? [];
    }
    // Return first available
    for (const meshes of this.meshSets.values()) {
      if (meshes.length > 0) return meshes;
    }
    return [];
  }

  /**
   * Get all mesh sets organized by builder type.
   */
  getMeshSets(): ReadonlyMap<MeshBuilderType, WavefrontMesh[]> {
    return this.meshSets;
  }

  /**
   * Get list of builder types that have meshes.
   */
  getActiveBuilderTypes(): MeshBuilderType[] {
    return [...this.meshSets.keys()].filter(
      (type) => (this.meshSets.get(type)?.length ?? 0) > 0,
    );
  }

  /**
   * Get wavefront mesh for a specific wave source index.
   */
  getMeshForWave(
    index: number,
    builderType?: MeshBuilderType,
  ): WavefrontMesh | undefined {
    return this.getMeshes(builderType)[index];
  }

  /**
   * Get the packed mesh buffer for query shader binding.
   */
  getPackedMeshBuffer(): GPUBuffer | null {
    return this.packedMeshBuffer;
  }

  /**
   * Get the rasterizer for rendering meshes to screen-space texture.
   */
  getRasterizer(): WavefrontRasterizer {
    return this.rasterizer;
  }

  /**
   * Get the currently active builder type.
   */
  getActiveBuilderType(): MeshBuilderType {
    return this.activeBuilderType;
  }

  /**
   * Set the active builder type and rebuild packed mesh buffer.
   */
  setActiveBuilderType(type: MeshBuilderType): void {
    if (this.activeBuilderType === type) return;
    this.activeBuilderType = type;
    this.rebuildPackedMeshBuffer();
  }

  /**
   * Get meshes for the currently active builder type.
   */
  getActiveMeshes(): readonly WavefrontMesh[] {
    return this.getMeshes(this.activeBuilderType);
  }

  /**
   * Rebuild the packed mesh buffer from the active builder type's meshes.
   */
  private rebuildPackedMeshBuffer(): void {
    this.packedMeshBuffer?.destroy();
    const meshes = this.getActiveMeshes();
    if (meshes.length > 0) {
      this.packedMeshBuffer = buildPackedMeshBuffer(this.device, meshes);
    } else {
      this.packedMeshBuffer = createPlaceholderPackedMeshBuffer(this.device);
    }
  }

  /**
   * Recompute wavefront meshes for updated terrain.
   */
  async recompute(
    terrainDef: TerrainDefinition,
    terrainGPUData?: TerrainCPUData,
    tideHeight?: number,
  ): Promise<void> {
    this.destroyResources();
    await this.initialize(terrainDef, terrainGPUData, tideHeight);
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.destroyResources();
    this.meshCoordinator.terminate();
    this.rasterizer.destroy();
  }

  private destroyResources(): void {
    this.packedMeshBuffer?.destroy();
    this.packedMeshBuffer = null;
    for (const meshes of this.meshSets.values()) {
      for (const mesh of meshes) {
        mesh.destroy();
      }
    }
    this.meshSets = new Map();
    this.initialized = false;
  }
}
