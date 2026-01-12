/**
 * Pool of readback buffers for tiles.
 *
 * Manages double-buffered GPU readback for multiple tiles.
 * Each buffer in the pool can be assigned to a tile for a frame,
 * allowing parallel readback from different tile regions.
 */

import type { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import type { WaveData } from "../cpu/WaterComputeCPU";
import {
  ReadbackViewport,
  WaterReadbackBuffer,
} from "../webgpu/WaterReadbackBuffer";
import type { Tile } from "./TileTypes";

/**
 * Statistics for tile readback operations.
 */
export interface TileReadbackStats {
  /** Number of queries satisfied from tile buffers */
  tileHits: number;
  /** Number of queries that fell back to CPU computation */
  cpuFallbacks: number;
  /** Number of tile readbacks completed this frame */
  readbacksCompleted: number;
  /** Reset counters to zero */
  reset(): void;
}

/**
 * Pool of readback buffers for tiles.
 */
export class TileReadbackPool {
  private buffers: WaterReadbackBuffer[] = [];
  private tileAssignments = new Map<number, Tile>();
  private initialized = false;

  readonly stats: TileReadbackStats = {
    tileHits: 0,
    cpuFallbacks: 0,
    readbacksCompleted: 0,
    reset() {
      this.tileHits = 0;
      this.cpuFallbacks = 0;
      this.readbacksCompleted = 0;
    },
  };

  constructor(
    private poolSize: number,
    private tileResolution: number,
  ) {}

  /**
   * Initialize GPU resources for all buffers in the pool.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    for (let i = 0; i < this.poolSize; i++) {
      const buffer = new WaterReadbackBuffer(this.tileResolution);
      await buffer.init();
      this.buffers.push(buffer);
    }

    this.initialized = true;
  }

  /**
   * Assign buffers to tiles for this frame.
   * Clears previous assignments and assigns buffers to the given tiles.
   */
  assignBuffersToTiles(tiles: Tile[]): void {
    // Clear old assignments
    for (const tile of this.tileAssignments.values()) {
      tile.bufferIndex = -1;
    }
    this.tileAssignments.clear();

    // Assign buffers to new tiles
    for (let i = 0; i < Math.min(tiles.length, this.poolSize); i++) {
      tiles[i].bufferIndex = i;
      this.tileAssignments.set(i, tiles[i]);
    }
  }

  /**
   * Get buffer for a tile.
   */
  getBufferForTile(tile: Tile): WaterReadbackBuffer | null {
    if (tile.bufferIndex < 0 || tile.bufferIndex >= this.buffers.length) {
      return null;
    }
    return this.buffers[tile.bufferIndex];
  }

  /**
   * Get buffer by index.
   */
  getBuffer(index: number): WaterReadbackBuffer | null {
    return this.buffers[index] ?? null;
  }

  /**
   * Get the tile assigned to a buffer index.
   */
  getTileForBuffer(index: number): Tile | undefined {
    return this.tileAssignments.get(index);
  }

  /**
   * Initiate readback for a specific buffer.
   */
  initiateReadback(
    index: number,
    texture: GPUTexture,
    viewport: ReadbackViewport,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    const buffer = this.buffers[index];
    if (buffer) {
      buffer.initiateReadback(texture, viewport, gpuProfiler);
    }
  }

  /**
   * Complete all pending readbacks.
   */
  async completeAllReadbacks(): Promise<void> {
    let completed = 0;
    await Promise.all(
      this.buffers.map(async (b) => {
        const success = await b.completeReadback();
        if (success) completed++;
      }),
    );
    this.stats.readbacksCompleted = completed;
  }

  /**
   * Sample from the buffer assigned to a tile at world coordinates.
   * Returns wave data or null if the point is not in the tile's viewport.
   */
  sampleAtWorldPoint(
    tile: Tile,
    worldX: number,
    worldY: number,
  ): WaveData | null {
    const buffer = this.getBufferForTile(tile);
    if (!buffer) return null;

    const result = buffer.sampleAt(worldX, worldY);
    if (result) {
      this.stats.tileHits++;
    }
    return result;
  }

  /**
   * Check if initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the pool size.
   */
  getPoolSize(): number {
    return this.poolSize;
  }

  /**
   * Get the number of assigned tiles.
   */
  getAssignedCount(): number {
    return this.tileAssignments.size;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    this.buffers = [];
    this.tileAssignments.clear();
    this.initialized = false;
  }
}
