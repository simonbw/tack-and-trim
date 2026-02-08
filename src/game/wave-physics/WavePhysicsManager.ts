/**
 * Wave Physics Manager
 *
 * Manages analytical wave physics computation:
 * - Manages coastline data and shadow polygon geometry
 * - Provides shadow data buffer for analytical Fresnel diffraction in shaders
 */

import { V, V2d } from "../../core/Vector";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { TerrainDefinition } from "../world/terrain/LandMass";
import { CoastlineManager } from "./CoastlineManager";
import {
  buildShadowPolygonsForRendering,
  type ShadowPolygonRenderData,
} from "./ShadowGeometry";

/** Maximum number of shadow polygons for wave diffraction */
export const MAX_SHADOW_POLYGONS = 8;

/** Maximum vertices per shadow polygon (coastline samples + 2 extended endpoints) */
export const MAX_VERTICES_PER_POLYGON = 34;

/** Maximum total vertices across all shadow polygons */
export const MAX_SHADOW_VERTICES =
  MAX_SHADOW_POLYGONS * MAX_VERTICES_PER_POLYGON;

/** Shadow data section size in floats: header (8 floats) + polygons (MAX * 12 floats each) */
const SHADOW_DATA_FLOATS = 8 + MAX_SHADOW_POLYGONS * 12;

/** Shadow vertices section size in floats: 2 floats (x, y) per vertex */
const SHADOW_VERTICES_FLOATS = MAX_SHADOW_VERTICES * 2;

/** Total packed shadow buffer size in bytes */
const PACKED_SHADOW_BUFFER_SIZE =
  (SHADOW_DATA_FLOATS + SHADOW_VERTICES_FLOATS) * 4;

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Provides shadow polygon data for Fresnel diffraction computation in shaders.
 */
export class WavePhysicsManager {
  private coastlineManager = new CoastlineManager();

  /** Packed shadow buffer containing both shadow data and vertices */
  private packedShadowBuffer: GPUBuffer | null = null;

  /** Shadow polygons for analytical diffraction */
  private shadowPolygons: ShadowPolygonRenderData[] = [];

  /** The wave source direction in world coordinates (from WAVE_COMPONENTS) */
  private waveDirection: V2d;

  /** Whether the manager has been initialized with terrain */
  private initialized = false;

  /**
   * Create a WavePhysicsManager with a specified wave direction.
   * @param waveDirection - Wave direction angle in radians (default 0.8 rad ≈ 45°)
   */
  constructor(waveDirection: number = 0.8) {
    this.waveDirection = V(Math.cos(waveDirection), Math.sin(waveDirection));
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

    // Build shadow polygons using edge-normal classification
    this.shadowPolygons = buildShadowPolygonsForRendering(
      [], // silhouettePoints parameter is deprecated
      coastlineData,
      this.waveDirection,
    );

    // Create packed shadow buffer (data + vertices in one buffer)
    this.packedShadowBuffer = device.createBuffer({
      size: PACKED_SHADOW_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Packed Shadow Buffer",
    });

    // Write initial shadow data
    this.updateShadowBuffers();

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
   * Update the packed shadow buffer with polygon data.
   * Called once during initialization (shadow geometry is static).
   *
   * Packed layout (all u32, floats via bitcast):
   * ```
   * [0] waveDir.x (f32)
   * [1] waveDir.y (f32)
   * [2] polygonCount (u32)
   * [3] verticesOffset (u32) - element index where vertex data starts
   * [4..7] unused/padding
   * [8..] polygons array (12 floats each)
   * [verticesOffset..] vertices (2 floats each, x/y pairs)
   * ```
   */
  private updateShadowBuffers(): void {
    if (!this.packedShadowBuffer) return;

    const device = getWebGPU().device;

    const totalFloats = SHADOW_DATA_FLOATS + SHADOW_VERTICES_FLOATS;
    const data = new ArrayBuffer(totalFloats * 4);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);

    // Vertices start after the shadow data section
    const verticesOffset = SHADOW_DATA_FLOATS;

    // Header
    floatView[0] = this.waveDirection.x;
    floatView[1] = this.waveDirection.y;
    uintView[2] = Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS);
    uintView[3] = verticesOffset; // verticesOffset (repurposed from _unused1)
    floatView[4] = 0; // unused
    floatView[5] = 0; // unused
    floatView[6] = 0; // unused
    floatView[7] = 0; // padding

    let currentVertexIndex = 0;
    const polygonOffset = 8; // floats before polygon array in data buffer

    for (
      let i = 0;
      i < Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS);
      i++
    ) {
      const polygon = this.shadowPolygons[i];
      const base = polygonOffset + i * 12; // 12 floats per polygon

      // Compute AABB from vertices
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const vertex of polygon.vertices) {
        minX = Math.min(minX, vertex.x);
        minY = Math.min(minY, vertex.y);
        maxX = Math.max(maxX, vertex.x);
        maxY = Math.max(maxY, vertex.y);
      }

      // Write polygon metadata
      floatView[base + 0] = polygon.leftSilhouette.x;
      floatView[base + 1] = polygon.leftSilhouette.y;
      floatView[base + 2] = polygon.rightSilhouette.x;
      floatView[base + 3] = polygon.rightSilhouette.y;
      floatView[base + 4] = polygon.obstacleWidth;
      uintView[base + 5] = currentVertexIndex;
      uintView[base + 6] = polygon.vertices.length;
      floatView[base + 7] = 0; // padding
      floatView[base + 8] = minX; // bboxMin.x
      floatView[base + 9] = minY; // bboxMin.y
      floatView[base + 10] = maxX; // bboxMax.x
      floatView[base + 11] = maxY; // bboxMax.y

      // Write polygon vertices into the vertices section
      for (const vertex of polygon.vertices) {
        floatView[verticesOffset + currentVertexIndex * 2] = vertex.x;
        floatView[verticesOffset + currentVertexIndex * 2 + 1] = vertex.y;
        currentVertexIndex++;
      }
    }

    device.queue.writeBuffer(this.packedShadowBuffer, 0, data);

    console.log(
      `[WavePhysicsManager] Uploaded ${currentVertexIndex} vertices for ${Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS)} shadow polygons`,
    );
  }

  /**
   * Get the packed shadow buffer for binding in shaders.
   * Contains both shadow data and vertices in a single `array<u32>` buffer.
   */
  getPackedShadowBuffer(): GPUBuffer | null {
    return this.packedShadowBuffer;
  }

  /**
   * Get the shadow polygons.
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
    this.packedShadowBuffer?.destroy();
    this.packedShadowBuffer = null;
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
