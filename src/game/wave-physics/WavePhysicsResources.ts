/**
 * Wave Physics Resources
 *
 * Singleton entity that owns and manages the WavePhysicsManager for analytical
 * wave-terrain interaction via wavefront meshes.
 *
 * Responsibilities:
 * - Initialize WavePhysicsManager with terrain data
 * - Provide access to packed mesh buffer for GPU shaders
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { MeshBuilderType } from "./mesh-building/MeshBuildTypes";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { DEFAULT_WAVE_CONFIG, WaveConfig } from "../world/water/WaveSource";
import { WaterResources } from "../world/water/WaterResources";
import { WavePhysicsManager } from "./WavePhysicsManager";
import type { WavefrontMesh } from "./WavefrontMesh";
import type { WavefrontRasterizer } from "./WavefrontRasterizer";

/**
 * Viewport bounds for rendering.
 */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Singleton entity that owns and manages WavePhysicsManager.
 */
export class WavePhysicsResources extends BaseEntity {
  id = "wavePhysicsResources";

  private waveConfig: WaveConfig;
  private wavePhysicsManager: WavePhysicsManager | null = null;
  private terrainResources: TerrainResources | null = null;

  constructor(waveConfig?: WaveConfig) {
    super();
    this.waveConfig = waveConfig ?? DEFAULT_WAVE_CONFIG;
  }

  @on("afterAdded")
  onAfterAdded() {
    // Create the wave physics manager now that we have access to the game/device
    const device = this.game.getWebGPUDevice();
    this.wavePhysicsManager = new WavePhysicsManager(device, this.waveConfig.sources);

    // Get terrain resources for wave physics initialization
    this.terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources) ?? null;

    // Initialize wave physics manager with terrain
    if (this.terrainResources) {
      const terrainDef = this.terrainResources.getTerrainDefinition();
      const waterResources = this.game.entities.tryGetSingleton(WaterResources);
      const tideHeight = waterResources?.getTideHeight() ?? 0;

      // Get raw terrain GPU data for worker-based mesh building
      const terrainGPUData = this.terrainResources.getTerrainGPUData();

      this.wavePhysicsManager.initialize(
        terrainDef,
        terrainGPUData
          ? {
              vertexData: terrainGPUData.vertexData,
              contourData: terrainGPUData.contourData,
              childrenData: terrainGPUData.childrenData,
              contourCount: terrainGPUData.contourCount,
              defaultDepth:
                terrainDef.defaultDepth ?? terrainGPUData.defaultDepth,
            }
          : undefined,
        tideHeight,
      );
    }
  }

  /**
   * Get the WavePhysicsManager instance.
   */
  getWavePhysicsManager(): WavePhysicsManager | null {
    return this.wavePhysicsManager;
  }

  /**
   * Get the packed mesh buffer for binding in query shaders.
   */
  getPackedMeshBuffer(): GPUBuffer | null {
    return this.wavePhysicsManager?.getPackedMeshBuffer() ?? null;
  }

  /**
   * Get the rasterizer for rendering meshes to screen-space texture.
   */
  getRasterizer(): WavefrontRasterizer | null {
    return this.wavePhysicsManager?.getRasterizer() ?? null;
  }

  /**
   * Get the active meshes (for the currently selected builder type).
   */
  getActiveMeshes(): readonly WavefrontMesh[] {
    return this.wavePhysicsManager?.getActiveMeshes() ?? [];
  }

  /**
   * Get the currently active builder type.
   */
  getActiveBuilderType(): MeshBuilderType {
    return this.wavePhysicsManager?.getActiveBuilderType() ?? "marching";
  }

  /**
   * Switch the active builder type and rebuild resources.
   */
  switchBuilderType(type: MeshBuilderType): void {
    this.wavePhysicsManager?.setActiveBuilderType(type);
  }

  /**
   * Check if wave physics is initialized and ready.
   */
  isInitialized(): boolean {
    return this.wavePhysicsManager?.isInitialized() ?? false;
  }

  @on("destroy")
  onDestroy(): void {
    this.wavePhysicsManager?.destroy();
  }
}
