/**
 * Manages GPU computation for tiles.
 *
 * Orchestrates wave and modifier computation for selected tiles,
 * using separate WaveComputeGPU instances per tile to avoid
 * texture overwrite issues.
 */

import type { GPUProfiler } from "../../../core/graphics/webgpu/GPUProfiler";
import type { Viewport } from "../webgpu/WaterComputePipelineGPU";
import { WaveComputeGPU } from "../webgpu/WaveComputeGPU";
import type { WaterInfo } from "../WaterInfo";
import { TileReadbackPool } from "./TileReadbackPool";
import type { Tile, TileGridConfig } from "./TileTypes";

/**
 * Manages GPU computation for tiles.
 */
export class TileComputePipeline {
  // One WaveComputeGPU per tile slot to avoid texture overwrite
  private waveComputes: WaveComputeGPU[] = [];
  private readbackPool: TileReadbackPool;
  private initialized = false;

  constructor(private config: TileGridConfig) {
    this.readbackPool = new TileReadbackPool(
      config.maxTilesPerFrame,
      config.tileResolution,
    );
  }

  /**
   * Initialize GPU resources.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Create one wave compute shader per tile slot
    for (let i = 0; i < this.config.maxTilesPerFrame; i++) {
      const waveCompute = new WaveComputeGPU(this.config.tileResolution);
      await waveCompute.init();
      this.waveComputes.push(waveCompute);
    }

    // Initialize readback pool
    await this.readbackPool.init();

    this.initialized = true;
  }

  /**
   * Compute water state for selected tiles and initiate readback.
   *
   * @param tiles Tiles to compute (from TileManager.selectTilesToCompute)
   * @param time Current game time
   * @param waterInfo WaterInfo for modifier data
   * @param gpuProfiler Optional GPU profiler
   */
  computeTiles(
    tiles: Tile[],
    time: number,
    _waterInfo: WaterInfo,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (!this.initialized || this.waveComputes.length === 0) return;

    // Assign buffers to tiles
    this.readbackPool.assignBuffersToTiles(tiles);

    // Compute each tile using its own WaveComputeGPU instance
    for (const tile of tiles) {
      if (tile.bufferIndex < 0 || tile.bufferIndex >= this.waveComputes.length)
        continue;

      const waveCompute = this.waveComputes[tile.bufferIndex];

      const viewport: Viewport = {
        left: tile.bounds.minX,
        top: tile.bounds.minY,
        width: tile.bounds.maxX - tile.bounds.minX,
        height: tile.bounds.maxY - tile.bounds.minY,
      };

      // Compute waves for this tile using its dedicated compute instance
      waveCompute.compute(
        time,
        viewport.left,
        viewport.top,
        viewport.width,
        viewport.height,
        gpuProfiler,
      );

      // Initiate readback from this tile's compute instance
      const outputTexture = waveCompute.getOutputTexture();
      if (outputTexture) {
        this.readbackPool.initiateReadback(
          tile.bufferIndex,
          outputTexture,
          { ...viewport, time },
          gpuProfiler,
        );
      }

      tile.lastComputedTime = time;
    }
  }

  /**
   * Complete all pending readbacks.
   * Should be called at the start of the next frame.
   */
  async completeReadbacks(): Promise<void> {
    await this.readbackPool.completeAllReadbacks();
  }

  /**
   * Get the readback pool for sampling tile data.
   */
  getReadbackPool(): TileReadbackPool {
    return this.readbackPool;
  }

  /**
   * Check if the pipeline is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the tile configuration.
   */
  getConfig(): TileGridConfig {
    return this.config;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    for (const waveCompute of this.waveComputes) {
      waveCompute.destroy();
    }
    this.waveComputes = [];
    this.readbackPool.destroy();
    this.initialized = false;
  }
}
