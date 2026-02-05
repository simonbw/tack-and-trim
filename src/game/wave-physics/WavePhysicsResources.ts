/**
 * Wave Physics Resources
 *
 * Singleton entity that owns and manages the WavePhysicsManager for shadow-based
 * wave diffraction. This centralizes wave physics resource management separate
 * from the tile-based query system.
 *
 * Responsibilities:
 * - Initialize WavePhysicsManager with terrain data
 * - Provide access to shadow texture and wave physics manager
 * - Update shadow texture each render frame
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WavePhysicsManager } from "./WavePhysicsManager";

/**
 * Viewport bounds for wave physics computation.
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
   * Get the shadow texture view for binding in shaders.
   */
  getShadowTextureView(): GPUTextureView | null {
    return this.wavePhysicsManager.getShadowTextureView();
  }

  /**
   * Get the shadow data buffer for binding in shaders.
   */
  getShadowDataBuffer(): GPUBuffer | null {
    return this.wavePhysicsManager.getShadowDataBuffer();
  }

  /**
   * Update the shadow texture for the given viewport.
   * Should be called each render frame before water shaders run.
   *
   * @param viewport - The viewport to render shadows for
   * @param timestampWrites - Optional GPU timestamp writes for profiling
   */
  updateShadowTexture(
    viewport: Viewport,
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void {
    if (this.wavePhysicsManager.isInitialized()) {
      this.wavePhysicsManager.updateShadowTexture(viewport, timestampWrites);
    }
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
