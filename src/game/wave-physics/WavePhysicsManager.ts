/**
 * Wave Physics Manager
 *
 * Manages analytical wave physics computation:
 * - Manages coastline data for terrain-wave interaction
 * - Coordinates worker-based wavefront mesh building
 * - Provides packed mesh data buffer for GPU shaders
 */

import type { TerrainDefinition } from "../world/terrain/LandMass";
import type { WaveSource } from "../world/water/WaveSource";
import { CoastlineManager } from "./CoastlineManager";
import type { WavefrontMesh } from "./WavefrontMesh";
import {
  buildPackedMeshBuffer,
  createPlaceholderPackedMeshBuffer,
} from "./MeshPacking";
import { WavefrontRasterizer } from "./WavefrontRasterizer";
import {
  MeshBuildCoordinator,
  type TerrainGPUData,
} from "./mesh-building/MeshBuildCoordinator";
import type { MeshBuilderType } from "./mesh-building/MeshBuildTypes";

/** Maximum number of wave sources for mesh computation */
export const MAX_WAVE_SOURCES = 8;

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Builds wavefront meshes for per-wave energy, direction, and phase correction.
 */
export class WavePhysicsManager {
  private coastlineManager = new CoastlineManager();

  /** Wavefront meshes organized by builder type */
  private meshSets = new Map<MeshBuilderType, WavefrontMesh[]>();

  /** Coordinator for worker-based mesh building */
  private meshCoordinator = new MeshBuildCoordinator();

  /** Active builder types to build meshes for */
  private activeBuilderTypes: MeshBuilderType[] = [
    "cpu-lagrangian",
    "grid-eulerian",
    "terrain-eulerian",
  ];

  /** Currently selected builder type for rendering/queries */
  private activeBuilderType: MeshBuilderType = "cpu-lagrangian";

  /** Packed mesh buffer for query shader lookup */
  private packedMeshBuffer: GPUBuffer | null = null;

  /** Rasterizer for rendering meshes to screen-space texture */
  private rasterizer = new WavefrontRasterizer();

  /** Whether the manager has been initialized with terrain */
  private initialized = false;

  /**
   * Create a WavePhysicsManager.
   * @param waveSources - Wave source configurations
   */
  constructor(private waveSources: WaveSource[] = []) {}

  /**
   * Initialize the wave physics manager with terrain data.
   * Computes wavefront meshes for each wave source.
   *
   * @param terrainDef - Terrain definition for coastline extraction
   * @param terrainGPUData - Raw typed arrays from buildTerrainGPUData() (for worker mesh builds)
   * @param tideHeight - Current tide height
   */
  async initialize(
    terrainDef: TerrainDefinition,
    terrainGPUData?: TerrainGPUData,
    tideHeight?: number,
  ): Promise<void> {
    // Initialize coastline manager
    this.coastlineManager.initialize(terrainDef);

    // Get coastline contours
    const coastlines = this.coastlineManager.getCoastlines();

    // Initialize rasterizer
    await this.rasterizer.init();

    // Build wavefront meshes via workers if terrain data is available
    if (terrainGPUData && tideHeight !== undefined) {
      const coastlineBounds = this.coastlineManager.getAllTerrainBounds();

      try {
        await this.meshCoordinator.initialize();
        this.meshSets = await this.meshCoordinator.buildMeshes(
          this.waveSources,
          terrainGPUData,
          coastlineBounds,
          tideHeight,
          this.activeBuilderTypes,
        );
      } catch (err) {
        console.error("[WavePhysicsManager] Mesh build failed:", err);
        this.meshSets = new Map();
      }
    }

    // Build packed mesh buffer for query shader
    this.rebuildPackedMeshBuffer();

    this.initialized = true;
    console.log(
      `[WavePhysicsManager] Initialized with ${coastlines.length} coastlines, ` +
        `${this.waveSources.length} wave sources, ${this.getTotalMeshCount()} wavefront meshes`,
    );
  }

  /**
   * Get the coastline manager.
   */
  getCoastlineManager(): CoastlineManager {
    return this.coastlineManager;
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
   * Get total mesh count across all builder types.
   */
  private getTotalMeshCount(): number {
    let count = 0;
    for (const meshes of this.meshSets.values()) {
      count += meshes.length;
    }
    return count;
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
    console.log(`[WavePhysicsManager] Switched to builder type: ${type}`);
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
      this.packedMeshBuffer = buildPackedMeshBuffer(meshes);
    } else {
      this.packedMeshBuffer = createPlaceholderPackedMeshBuffer();
    }
  }

  /**
   * Recompute wavefront meshes for updated terrain.
   */
  async recompute(
    terrainDef: TerrainDefinition,
    terrainGPUData?: TerrainGPUData,
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
    this.coastlineManager.clear();
    this.initialized = false;
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): {
    coastlineCount: number;
  } {
    return {
      coastlineCount: this.coastlineManager.getCoastlineCount(),
    };
  }
}
