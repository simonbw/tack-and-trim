/**
 * Wave Physics Manager
 *
 * Manages analytical wave physics computation:
 * - Manages coastline data and shadow polygon geometry
 * - Builds per-wave-source shadow polygon sets for Fresnel diffraction
 * - Provides packed shadow data buffer for GPU shaders
 */

import { V, V2d } from "../../core/Vector";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { TerrainDefinition } from "../world/terrain/LandMass";
import type { WaveSource } from "../world/water/WaveSource";
import { CoastlineManager } from "./CoastlineManager";
import {
  buildShadowPolygonsForRendering,
  type ShadowPolygonRenderData,
} from "./ShadowGeometry";

/** Maximum number of wave sources for shadow computation */
export const MAX_WAVE_SOURCES = 8;

/** Maximum number of shadow polygons per wave source */
export const MAX_SHADOW_POLYGONS = 8;

/** Maximum vertices per shadow polygon (coastline samples + 2 extended endpoints) */
export const MAX_VERTICES_PER_POLYGON = 34;

/** Maximum total vertices per wave source */
const MAX_VERTICES_PER_WAVE = MAX_SHADOW_POLYGONS * MAX_VERTICES_PER_POLYGON;

/**
 * Per-wave polygon set header size in u32s:
 * [+0] waveDir.x (f32)
 * [+1] waveDir.y (f32)
 * [+2] polygonCount (u32)
 * [+3] verticesOffset (u32) -- absolute from buffer start
 * [+4..7] padding
 */
const WAVE_SET_HEADER_U32S = 8;

/** Polygon metadata size in u32s (12 per polygon, matching PolygonShadowData) */
const POLYGON_U32S = 12;

/**
 * Per-wave polygon set size in u32s:
 * header (8) + polygons (MAX * 12) + vertices (MAX_VERTICES * 2)
 */
const WAVE_SET_DATA_U32S =
  WAVE_SET_HEADER_U32S + MAX_SHADOW_POLYGONS * POLYGON_U32S;
const WAVE_SET_VERTICES_U32S = MAX_VERTICES_PER_WAVE * 2;
const WAVE_SET_TOTAL_U32S = WAVE_SET_DATA_U32S + WAVE_SET_VERTICES_U32S;

/**
 * Global header size in u32s:
 * [0]    numWaveSources
 * [1-8]  waveSetOffset[0..7] -- absolute offset to each wave source's polygon set
 * [9-15] padding
 */
const GLOBAL_HEADER_U32S = 16;

/** Total packed shadow buffer size in u32s */
const PACKED_SHADOW_BUFFER_U32S =
  GLOBAL_HEADER_U32S + MAX_WAVE_SOURCES * WAVE_SET_TOTAL_U32S;

/** Total packed shadow buffer size in bytes */
const PACKED_SHADOW_BUFFER_SIZE = PACKED_SHADOW_BUFFER_U32S * 4;

/** Per-wave shadow polygon set data (for CPU-side access) */
interface WavePolygonSet {
  direction: V2d;
  polygons: ShadowPolygonRenderData[];
}

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Builds per-wave-source shadow polygon sets for Fresnel diffraction in shaders.
 */
export class WavePhysicsManager {
  private coastlineManager = new CoastlineManager();

  /** Packed shadow buffer containing per-wave shadow data */
  private packedShadowBuffer: GPUBuffer | null = null;

  /** Per-wave shadow polygon sets */
  private wavePolygonSets: WavePolygonSet[] = [];

  /** Whether the manager has been initialized with terrain */
  private initialized = false;

  /**
   * Create a WavePhysicsManager.
   * @param waveSources - Wave source configurations (direction used for shadow geometry)
   */
  constructor(private waveSources: WaveSource[] = []) {}

  /**
   * Initialize the wave physics manager with terrain data.
   * Computes shadow geometry for each wave source direction.
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

    // Build shadow polygons for each wave source direction
    this.wavePolygonSets = [];
    const numSources = Math.min(this.waveSources.length, MAX_WAVE_SOURCES);
    for (let i = 0; i < numSources; i++) {
      const source = this.waveSources[i];
      const dir = V(Math.cos(source.direction), Math.sin(source.direction));
      const polygons = buildShadowPolygonsForRendering([], coastlineData, dir);
      this.wavePolygonSets.push({ direction: dir, polygons });
    }

    // Create packed shadow buffer
    this.packedShadowBuffer = device.createBuffer({
      size: PACKED_SHADOW_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Packed Shadow Buffer",
    });

    // Write shadow data
    this.updateShadowBuffers();

    this.initialized = true;
    console.log(
      `[WavePhysicsManager] Initialized with ${coastlines.length} coastlines, ` +
        `${numSources} wave sources`,
    );
    for (let i = 0; i < this.wavePolygonSets.length; i++) {
      const set = this.wavePolygonSets[i];
      const deg = (
        (Math.atan2(set.direction.y, set.direction.x) * 180) /
        Math.PI
      ).toFixed(1);
      console.log(
        `[WavePhysicsManager]   Wave ${i}: dir=${deg}°, ${set.polygons.length} shadow polygons`,
      );
    }
  }

  /**
   * Update the packed shadow buffer with per-wave polygon data.
   *
   * Buffer layout:
   * ```
   * GLOBAL HEADER (16 u32s):
   * [0]    numWaveSources
   * [1-8]  waveSetOffset[0..7] -- absolute u32 offset to each wave's polygon set
   * [9-15] padding
   *
   * PER-WAVE POLYGON SET (at absolute offset, one per wave source):
   * [+0]   waveDir.x (f32)
   * [+1]   waveDir.y (f32)
   * [+2]   polygonCount (u32)
   * [+3]   verticesOffset (u32) -- absolute from buffer start
   * [+4..7] padding
   * [+8..] polygons (12 u32s each)
   * [+verticesOffset..] vertices (2 floats each)
   * ```
   */
  private updateShadowBuffers(): void {
    if (!this.packedShadowBuffer) return;

    const device = getWebGPU().device;

    const data = new ArrayBuffer(PACKED_SHADOW_BUFFER_SIZE);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);

    const numSources = this.wavePolygonSets.length;

    // Global header
    uintView[0] = numSources;
    for (let i = 0; i < MAX_WAVE_SOURCES; i++) {
      uintView[1 + i] = GLOBAL_HEADER_U32S + i * WAVE_SET_TOTAL_U32S;
    }
    // padding [9..15] already zero

    // Per-wave polygon sets
    let totalVertices = 0;
    for (let w = 0; w < numSources; w++) {
      const set = this.wavePolygonSets[w];
      const setBase = GLOBAL_HEADER_U32S + w * WAVE_SET_TOTAL_U32S;

      // Vertices for this wave source start after the polygon data section
      const verticesOffset = setBase + WAVE_SET_DATA_U32S;

      // Wave set header
      floatView[setBase + 0] = set.direction.x;
      floatView[setBase + 1] = set.direction.y;
      uintView[setBase + 2] = Math.min(
        set.polygons.length,
        MAX_SHADOW_POLYGONS,
      );
      uintView[setBase + 3] = verticesOffset;
      // [+4..7] padding, already zero

      let currentVertexIndex = 0;
      const polygonBase = setBase + WAVE_SET_HEADER_U32S;

      for (
        let i = 0;
        i < Math.min(set.polygons.length, MAX_SHADOW_POLYGONS);
        i++
      ) {
        const polygon = set.polygons[i];
        const base = polygonBase + i * POLYGON_U32S;

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
        floatView[base + 8] = minX;
        floatView[base + 9] = minY;
        floatView[base + 10] = maxX;
        floatView[base + 11] = maxY;

        // Write polygon vertices
        for (const vertex of polygon.vertices) {
          floatView[verticesOffset + currentVertexIndex * 2] = vertex.x;
          floatView[verticesOffset + currentVertexIndex * 2 + 1] = vertex.y;
          currentVertexIndex++;
        }
      }

      totalVertices += currentVertexIndex;
    }

    device.queue.writeBuffer(this.packedShadowBuffer, 0, data);

    console.log(
      `[WavePhysicsManager] Uploaded ${totalVertices} total vertices across ${numSources} wave sources`,
    );
  }

  /**
   * Get the packed shadow buffer for binding in shaders.
   */
  getPackedShadowBuffer(): GPUBuffer | null {
    return this.packedShadowBuffer;
  }

  /**
   * Get shadow polygons for a specific wave source index.
   */
  getShadowPolygonsForWave(index: number): ShadowPolygonRenderData[] {
    return this.wavePolygonSets[index]?.polygons ?? [];
  }

  /**
   * Get wave directions for all wave sources.
   */
  getWaveDirections(): V2d[] {
    return this.wavePolygonSets.map((set) => set.direction);
  }

  /**
   * Get the number of wave sources with shadow data.
   */
  getWaveSourceCount(): number {
    return this.wavePolygonSets.length;
  }

  /**
   * Get the coastline manager.
   */
  getCoastlineManager(): CoastlineManager {
    return this.coastlineManager;
  }

  /**
   * Get the total number of shadow polygons across all wave sources.
   */
  getPolygonCount(): number {
    return this.wavePolygonSets.reduce(
      (sum, set) => sum + set.polygons.length,
      0,
    );
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
    this.wavePolygonSets = [];
    this.initialized = false;
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): {
    coastlineCount: number;
    polygonCount: number;
    waveSourceCount: number;
  } {
    return {
      coastlineCount: this.coastlineManager.getCoastlineCount(),
      polygonCount: this.getPolygonCount(),
      waveSourceCount: this.wavePolygonSets.length,
    };
  }
}
