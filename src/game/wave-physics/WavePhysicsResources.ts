/**
 * Wave Physics Resources
 *
 * Singleton entity that owns and manages the WavePhysicsManager for analytical
 * wave diffraction. This centralizes wave physics resource management.
 *
 * Responsibilities:
 * - Initialize WavePhysicsManager with terrain data
 * - Provide access to shadow data buffer for analytical Fresnel diffraction
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WavePhysicsManager } from "./WavePhysicsManager";

/**
 * Viewport bounds (kept for backwards compatibility, no longer used for shadows).
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

  private wavePhysicsManager: WavePhysicsManager;
  private terrainResources: TerrainResources | null = null;

  constructor() {
    super();
    this.wavePhysicsManager = new WavePhysicsManager();
  }

  @on("afterAdded")
  onAfterAdded() {
    // Get terrain resources for wave physics initialization
    this.terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources) ?? null;

    // Initialize wave physics manager with terrain
    if (this.terrainResources) {
      const terrainDef = this.terrainResources.getTerrainDefinition();
      this.wavePhysicsManager.initialize(terrainDef);
    }
  }

  /**
   * Get the WavePhysicsManager instance.
   */
  getWavePhysicsManager(): WavePhysicsManager {
    return this.wavePhysicsManager;
  }

  /**
   * Get the shadow data buffer for binding in shaders.
   */
  getShadowDataBuffer(): GPUBuffer | null {
    return this.wavePhysicsManager.getShadowDataBuffer();
  }

  /**
   * Get the shadow vertices buffer for binding in shaders.
   */
  getShadowVerticesBuffer(): GPUBuffer | null {
    return this.wavePhysicsManager.getShadowVerticesBuffer();
  }

  /**
   * Check if wave physics is initialized and ready.
   */
  isInitialized(): boolean {
    return this.wavePhysicsManager.isInitialized();
  }

  @on("destroy")
  onDestroy(): void {
    this.wavePhysicsManager.destroy();
  }
}
