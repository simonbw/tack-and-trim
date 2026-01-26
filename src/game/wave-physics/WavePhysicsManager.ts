/**
 * Wave Physics Manager
 *
 * Orchestrates analytical wave physics computation using texture-based shadow system:
 * - Manages coastline data and shadow polygon geometry
 * - Renders shadow polygons to a texture via ShadowTextureRenderer
 * - Provides shadow texture and silhouette data buffer for the water shader
 */

import { V, V2d } from "../../core/Vector";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { WAVE_COMPONENTS } from "../world-data/water/WaterConstants";
import type { Viewport } from "../world-data/water/WaterInfo";
import type { TerrainDefinition } from "../world-data/terrain/LandMass";
import { CoastlineManager } from "./CoastlineManager";
import {
  buildShadowPolygonsForRendering,
  type ShadowPolygonRenderData,
} from "./ShadowGeometry";
import { ShadowTextureRenderer } from "./ShadowTextureRenderer";
import { computeAllSilhouettePoints } from "./SilhouetteComputation";
import { MAX_SHADOW_POLYGONS } from "../world-data/water/webgpu/AnalyticalWaterStateShader";

/** Shadow data buffer byte size: header (32 bytes) + polygons (MAX * 32 bytes each) */
const SHADOW_DATA_BUFFER_SIZE = 32 + MAX_SHADOW_POLYGONS * 32;

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Uses texture-based shadow system for efficient per-pixel shadow testing.
 */
export class WavePhysicsManager {
  private coastlineManager = new CoastlineManager();

  /** Shadow texture renderer */
  private shadowRenderer: ShadowTextureRenderer | null = null;

  /** Shadow data uniform buffer for silhouette positions */
  private shadowDataBuffer: GPUBuffer | null = null;

  /** Render-ready shadow polygons */
  private shadowPolygons: ShadowPolygonRenderData[] = [];

  /** The wave source direction in world coordinates (from WAVE_COMPONENTS) */
  private waveDirection: V2d;

  /** Whether the manager has been initialized with terrain */
  private initialized = false;

  /** Shadow texture dimensions */
  private shadowTextureWidth = 256;
  private shadowTextureHeight = 256;

  constructor() {
    // Get the wave direction from WAVE_COMPONENTS (all waves share the same direction)
    const angle = WAVE_COMPONENTS[0][2]; // direction is at index 2
    this.waveDirection = V(Math.cos(angle), Math.sin(angle));
  }

  /**
   * Initialize the wave physics manager with terrain data.
   * Computes shadow geometry for the wave source direction.
   *
   * @param terrainDef - Terrain definition with contours
   */
  async initialize(terrainDef: TerrainDefinition): Promise<void> {
    const device = getWebGPU().device;

    // Initialize coastline manager
    this.coastlineManager.initialize(terrainDef);

    // Get coastline contours
    const coastlines = this.coastlineManager.getCoastlines();
    const coastlineData = coastlines.map((c) => ({
      contour: c.contour,
      contourIndex: c.contourIndex,
    }));

    // Find silhouette points using world-space wave direction
    // (silhouette computation is purely geometric - finds where tangent is parallel to wave)
    const silhouettePoints = computeAllSilhouettePoints(
      coastlineData,
      this.waveDirection,
    );

    // Build render-ready shadow polygons
    this.shadowPolygons = buildShadowPolygonsForRendering(
      silhouettePoints,
      coastlineData,
      this.waveDirection,
    );

    // Initialize shadow texture renderer
    this.shadowRenderer = new ShadowTextureRenderer(
      this.shadowTextureWidth,
      this.shadowTextureHeight,
    );
    await this.shadowRenderer.init();

    // Create shadow data uniform buffer
    this.shadowDataBuffer = device.createBuffer({
      size: SHADOW_DATA_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Shadow Data Uniform Buffer",
    });

    this.initialized = true;
    console.log(
      `[WavePhysicsManager] Initialized with ${coastlines.length} coastlines, ` +
        `wave direction: ${((Math.atan2(this.waveDirection.y, this.waveDirection.x) * 180) / Math.PI).toFixed(1)}°`,
    );
    console.log(
      `[WavePhysicsManager] Shadow polygons: ${this.shadowPolygons.length} (max ${MAX_SHADOW_POLYGONS})`,
    );
  }

  /**
   * Update the shadow texture for the current viewport.
   * Must be called each frame before water shader runs.
   *
   * @param viewport - Current render viewport
   */
  updateShadowTexture(viewport: Viewport): void {
    if (!this.initialized || !this.shadowRenderer || !this.shadowDataBuffer) {
      return;
    }

    // Render shadow polygons to texture (uses pre-computed polygon.vertices)
    this.shadowRenderer.render(viewport, this.shadowPolygons);

    // Update shadow data uniform buffer
    this.updateShadowDataBuffer(viewport);
  }

  /**
   * Update the shadow data uniform buffer with current viewport and polygon data.
   */
  private updateShadowDataBuffer(viewport: Viewport): void {
    if (!this.shadowDataBuffer) return;

    const device = getWebGPU().device;

    // Buffer layout:
    // offset 0:  waveDirection (vec2<f32>)
    // offset 8:  polygonCount (u32)
    // offset 12: shadowViewportLeft (f32)
    // offset 16: shadowViewportTop (f32)
    // offset 20: shadowViewportWidth (f32)
    // offset 24: shadowViewportHeight (f32)
    // offset 28: padding (f32)
    // offset 32: polygons array start

    const data = new ArrayBuffer(SHADOW_DATA_BUFFER_SIZE);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);

    // Header
    floatView[0] = this.waveDirection.x;
    floatView[1] = this.waveDirection.y;
    uintView[2] = Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS);
    floatView[3] = viewport.left;
    floatView[4] = viewport.top;
    floatView[5] = viewport.width;
    floatView[6] = viewport.height;
    floatView[7] = 0; // padding

    // Per-polygon data (32 bytes each)
    // Layout per polygon:
    // offset 0:  leftSilhouette (vec2<f32>)
    // offset 8:  rightSilhouette (vec2<f32>)
    // offset 16: obstacleWidth (f32)
    // offset 20-28: padding (3 f32)

    const polygonOffset = 8; // floats before polygon array
    for (
      let i = 0;
      i < Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS);
      i++
    ) {
      const polygon = this.shadowPolygons[i];
      const base = polygonOffset + i * 8; // 8 floats per polygon

      floatView[base + 0] = polygon.leftSilhouette.x;
      floatView[base + 1] = polygon.leftSilhouette.y;
      floatView[base + 2] = polygon.rightSilhouette.x;
      floatView[base + 3] = polygon.rightSilhouette.y;
      floatView[base + 4] = polygon.obstacleWidth;
      floatView[base + 5] = 0; // padding
      floatView[base + 6] = 0; // padding
      floatView[base + 7] = 0; // padding
    }

    device.queue.writeBuffer(this.shadowDataBuffer, 0, data);
  }

  /**
   * Get the shadow texture view for binding in the water shader.
   */
  getShadowTextureView(): GPUTextureView | null {
    return this.shadowRenderer?.getTextureView() ?? null;
  }

  /**
   * Get the shadow data uniform buffer for binding in the water shader.
   */
  getShadowDataBuffer(): GPUBuffer | null {
    return this.shadowDataBuffer;
  }

  /**
   * Get the render-ready shadow polygons.
   * Useful for debugging and visualization.
   */
  getShadowPolygons(): ShadowPolygonRenderData[] {
    return this.shadowPolygons;
  }

  /**
   * Get the coastline manager.
   */
  getCoastlineManager(): CoastlineManager {
    return this.coastlineManager;
  }

  /**
   * Get the wave source direction.
   */
  getWaveDirection(): V2d {
    return this.waveDirection;
  }

  /**
   * Get the number of shadow polygons.
   */
  getPolygonCount(): number {
    return this.shadowPolygons.length;
  }

  /**
   * Check if the manager is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Recompute shadow geometry for updated terrain.
   */
  async recompute(terrainDef: TerrainDefinition): Promise<void> {
    this.destroy();
    await this.initialize(terrainDef);
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.shadowRenderer?.destroy();
    this.shadowDataBuffer?.destroy();
    this.shadowRenderer = null;
    this.shadowDataBuffer = null;
    this.coastlineManager.clear();
    this.shadowPolygons = [];
    this.initialized = false;
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): {
    coastlineCount: number;
    polygonCount: number;
  } {
    return {
      coastlineCount: this.coastlineManager.getCoastlineCount(),
      polygonCount: this.shadowPolygons.length,
    };
  }
}
