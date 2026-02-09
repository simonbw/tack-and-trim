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
import { DEFAULT_DEPTH } from "../world/terrain/TerrainConstants";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { DEFAULT_WAVE_CONFIG, WaveConfig } from "../world/water/WaveSource";
import { WaterResources } from "../world/water/WaterResources";
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

  constructor(waveConfig?: WaveConfig) {
    super();
    const config = waveConfig ?? DEFAULT_WAVE_CONFIG;
    this.wavePhysicsManager = new WavePhysicsManager(config.sources);
  }

  @on("afterAdded")
  onAfterAdded() {
    // Get terrain resources for wave physics initialization
    this.terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources) ?? null;

    // Initialize wave physics manager with terrain
    if (this.terrainResources) {
      const terrainDef = this.terrainResources.getTerrainDefinition();
      const waterResources = this.game.entities.tryGetSingleton(WaterResources);
      const tideHeight = waterResources?.getTideHeight() ?? 0;

      this.wavePhysicsManager.initialize(
        terrainDef,
        this.terrainResources.packedTerrainBuffer,
        this.terrainResources.getContourCount(),
        terrainDef.defaultDepth ?? DEFAULT_DEPTH,
        tideHeight,
      );
    }
  }

  /**
   * Get the WavePhysicsManager instance.
   */
  getWavePhysicsManager(): WavePhysicsManager {
    return this.wavePhysicsManager;
  }

  /**
   * Get the packed shadow buffer for binding in shaders.
   * Contains both shadow data and vertices in a single `array<u32>` buffer.
   */
  getPackedShadowBuffer(): GPUBuffer | null {
    return this.wavePhysicsManager.getPackedShadowBuffer();
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
