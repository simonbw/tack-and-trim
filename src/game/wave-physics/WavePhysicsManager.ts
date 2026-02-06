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

/** Shadow data buffer byte size: header (32 bytes) + polygons (MAX * 48 bytes each) */
const SHADOW_DATA_BUFFER_SIZE = 32 + MAX_SHADOW_POLYGONS * 48;

/** Shadow vertices buffer byte size: 2 floats (x, y) per vertex */
const SHADOW_VERTICES_BUFFER_SIZE = MAX_SHADOW_VERTICES * 2 * 4;

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Provides shadow polygon data for Fresnel diffraction computation in shaders.
 */
export class WavePhysicsManager {
  private coastlineManager = new CoastlineManager();

  /** Shadow data buffer for polygon metadata */
  private shadowDataBuffer: GPUBuffer | null = null;

  /** Shadow vertices buffer for polygon geometry */
  private shadowVerticesBuffer: GPUBuffer | null = null;

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

    // Create shadow data storage buffer
    this.shadowDataBuffer = device.createBuffer({
      size: SHADOW_DATA_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Shadow Data Storage Buffer",
    });

    // Create shadow vertices storage buffer
    this.shadowVerticesBuffer = device.createBuffer({
      size: SHADOW_VERTICES_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Shadow Vertices Storage Buffer",
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
   * Update the shadow buffers with polygon data.
   * Called once during initialization (shadow geometry is static).
   */
  private updateShadowBuffers(): void {
    if (!this.shadowDataBuffer || !this.shadowVerticesBuffer) return;

    const device = getWebGPU().device;

    // =========================================================================
    // Shadow Data Buffer Layout:
    // =========================================================================
    // offset 0:  waveDirection (vec2<f32>)
    // offset 8:  polygonCount (u32)
    // offset 12: unused (f32) - kept for struct alignment
    // offset 16: unused (f32)
    // offset 20: unused (f32)
    // offset 24: unused (f32)
    // offset 28: padding (f32)
    // offset 32: polygons array start
    //
    // Per-polygon data (48 bytes = 12 floats each):
    // offset 0:  leftSilhouette (vec2<f32>)
    // offset 8:  rightSilhouette (vec2<f32>)
    // offset 16: obstacleWidth (f32)
    // offset 20: vertexStartIndex (u32)
    // offset 24: vertexCount (u32)
    // offset 28: padding (f32)
    // offset 32: bboxMin (vec2<f32>)
    // offset 40: bboxMax (vec2<f32>)

    const data = new ArrayBuffer(SHADOW_DATA_BUFFER_SIZE);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);

    // Header
    floatView[0] = this.waveDirection.x;
    floatView[1] = this.waveDirection.y;
    uintView[2] = Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS);
    floatView[3] = 0; // unused
    floatView[4] = 0; // unused
    floatView[5] = 0; // unused
    floatView[6] = 0; // unused
    floatView[7] = 0; // padding

    // =========================================================================
    // Shadow Vertices Buffer Layout:
    // =========================================================================
    // Flat array of vec2<f32> vertices for all polygons.
    // Each polygon's vertices are stored contiguously.

    const verticesData = new ArrayBuffer(SHADOW_VERTICES_BUFFER_SIZE);
    const verticesView = new Float32Array(verticesData);

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

      // Write polygon vertices
      for (const vertex of polygon.vertices) {
        verticesView[currentVertexIndex * 2] = vertex.x;
        verticesView[currentVertexIndex * 2 + 1] = vertex.y;
        currentVertexIndex++;
      }
    }

    device.queue.writeBuffer(this.shadowDataBuffer, 0, data);
    device.queue.writeBuffer(this.shadowVerticesBuffer, 0, verticesData);

    console.log(
      `[WavePhysicsManager] Uploaded ${currentVertexIndex} vertices for ${Math.min(this.shadowPolygons.length, MAX_SHADOW_POLYGONS)} shadow polygons`,
    );
  }

  /**
   * Get the shadow data buffer for binding in shaders.
   */
  getShadowDataBuffer(): GPUBuffer | null {
    return this.shadowDataBuffer;
  }

  /**
   * Get the shadow vertices buffer for binding in shaders.
   */
  getShadowVerticesBuffer(): GPUBuffer | null {
    return this.shadowVerticesBuffer;
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
    this.shadowDataBuffer?.destroy();
    this.shadowDataBuffer = null;
    this.shadowVerticesBuffer?.destroy();
    this.shadowVerticesBuffer = null;
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
