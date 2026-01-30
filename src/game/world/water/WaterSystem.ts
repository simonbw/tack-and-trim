import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type { Game } from "../../../core/Game";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { BindGroupResources } from "../../../core/graphics/webgpu/ShaderBindings";
import { WaveSource, type WaveSourceConfig } from "./WaveSource";
import { WaterComputeShader, WaterComputeBindings } from "./WaterComputeShader";

/**
 * Configuration for the water system
 */
export interface WaterSystemConfig {
  /** Array of wave source configurations */
  waves: WaveSourceConfig[];
}

/**
 * Main water system entity that manages GPU-accelerated Gerstner wave simulation.
 *
 * This system:
 * - Maintains a collection of WaveSource objects
 * - Manages GPU resources (buffers, compute shader)
 * - Updates simulation time each tick
 * - Provides compute interface for WaterQueryManager
 *
 * Follows the pattern established by TerrainSystem and WindSystem.
 */
export class WaterSystem extends BaseEntity {
  readonly id = "waterSystem";
  readonly tickLayer = "environment";

  private waveSources: WaveSource[];
  private time = 0;
  private isInitialized = false;

  // GPU resources
  private computeShader: WaterComputeShader | null = null;
  private waveSourceBuffer: GPUBuffer | null = null;
  private waterParamsBuffer: GPUBuffer | null = null;

  constructor(config: WaterSystemConfig) {
    super();
    this.waveSources = config.waves.map(
      (waveConfig) => new WaveSource(waveConfig),
    );
  }

  /**
   * Initialize GPU resources
   */
  @on("add")
  async onAdd(): Promise<void> {
    try {
      const device = getWebGPU().device;

      // Initialize compute shader
      this.computeShader = new WaterComputeShader();
      await this.computeShader.init();

      // Create wave source buffer (8 floats per wave)
      const waveCount = this.waveSources.length;
      const waveDataSize = waveCount * 8 * Float32Array.BYTES_PER_ELEMENT;
      this.waveSourceBuffer = device.createBuffer({
        label: "WaterSystem Wave Sources",
        size: waveDataSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Upload wave data
      this.updateWaveSourceBuffer();

      // Create water params buffer (time, waveCount, padding)
      this.waterParamsBuffer = device.createBuffer({
        label: "WaterSystem Params",
        size: 4 * Float32Array.BYTES_PER_ELEMENT, // time, waveCount (as f32), 2x padding
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // Initial params upload
      this.updateWaterParamsBuffer();

      this.isInitialized = true;
      console.log(
        `[WaterSystem] Initialized with ${waveCount} wave sources at time=${this.time.toFixed(2)}s`,
      );
    } catch (error) {
      console.error("[WaterSystem] Failed to initialize:", error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Update simulation time each tick
   */
  @on("tick")
  onTick(dt: number): void {
    if (!this.isInitialized) {
      // Not yet initialized
      return;
    }

    // Validate dt to prevent NaN propagation
    if (!isFinite(dt) || dt < 0 || dt > 1) {
      console.warn(`[WaterSystem] Invalid dt=${dt}, skipping tick`);
      return;
    }

    this.time += dt;
    this.updateWaterParamsBuffer();
  }

  /**
   * Clean up GPU resources
   */
  @on("destroy")
  onDestroy(): void {
    this.computeShader?.destroy();
    this.computeShader = null;

    this.waveSourceBuffer?.destroy();
    this.waveSourceBuffer = null;

    this.waterParamsBuffer?.destroy();
    this.waterParamsBuffer = null;
  }

  /**
   * Called by WaterQueryManager to compute query results on GPU.
   *
   * @param pointBuffer GPU buffer containing query points (vec2f array)
   * @param resultBuffer GPU buffer to write results (f32 array, stride=6)
   * @param pointCount Number of points to process
   */
  computeQueryResults(
    pointBuffer: GPUBuffer,
    resultBuffer: GPUBuffer,
    pointCount: number,
  ): void {
    if (!this.isInitialized) {
      // System not yet initialized - skip silently
      return;
    }

    if (pointCount === 0) {
      // No points to process - skip dispatch
      return;
    }

    if (
      !this.computeShader ||
      !this.waveSourceBuffer ||
      !this.waterParamsBuffer
    ) {
      console.warn("[WaterSystem] GPU resources not initialized");
      return;
    }

    // Validate pointCount to prevent GPU hang
    if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > 8192) {
      console.error(
        `[WaterSystem] Invalid pointCount=${pointCount}, aborting dispatch`,
      );
      return;
    }

    const device = getWebGPU().device;
    // Update water params before dispatch
    this.updateWaterParamsBuffer();

    // Create bind group
    const bindGroupResources: BindGroupResources<typeof WaterComputeBindings> =
      {
        queryPoints: { buffer: pointBuffer },
        results: { buffer: resultBuffer },
        waveSources: { buffer: this.waveSourceBuffer },
        waterParams: { buffer: this.waterParamsBuffer },
      };

    const bindGroup = this.computeShader.createBindGroup(bindGroupResources);

    // Create command encoder and compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "WaterSystem Query Compute",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "WaterSystem Compute Pass",
    });

    // Dispatch compute shader
    this.computeShader.dispatch(computePass, bindGroup, pointCount, 1);

    computePass.end();

    // Submit to GPU queue
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Update wave source buffer with current wave data
   */
  private updateWaveSourceBuffer(): void {
    if (!this.waveSourceBuffer) return;

    const device = getWebGPU().device;
    const waveCount = this.waveSources.length;

    // Pack all wave data (8 floats per wave)
    const data = new Float32Array(waveCount * 8);
    for (let i = 0; i < waveCount; i++) {
      const waveData = this.waveSources[i].getGPUData();
      data.set(waveData, i * 8);
    }

    device.queue.writeBuffer(this.waveSourceBuffer, 0, data);
  }

  /**
   * Update water params buffer with current time and wave count
   */
  private updateWaterParamsBuffer(): void {
    if (!this.waterParamsBuffer) return;

    // Validate data before uploading to GPU
    if (!isFinite(this.time)) {
      console.error(
        `[WaterSystem] Invalid time value: ${this.time}, resetting to 0`,
      );
      this.time = 0;
    }

    const waveCount = this.waveSources.length;
    if (waveCount < 0 || waveCount > 100) {
      console.error(
        `[WaterSystem] Invalid wave count: ${waveCount}, aborting update`,
      );
      return;
    }

    const device = getWebGPU().device;
    const data = new Float32Array([
      this.time,
      waveCount, // waveCount as f32
      0, // padding
      0, // padding
    ]);

    device.queue.writeBuffer(this.waterParamsBuffer, 0, data);
  }

  /**
   * Get WaterSystem from game entities
   */
  static fromGame(game: Game): WaterSystem | null {
    return game.entities.getById("waterSystem") as WaterSystem | null;
  }

  /**
   * Get readonly array of wave sources
   */
  getWaveSources(): readonly WaveSource[] {
    return this.waveSources;
  }

  /**
   * Set amplitude for a specific wave source (runtime modulation)
   */
  setWaveAmplitude(index: number, amplitude: number): void {
    if (index < 0 || index >= this.waveSources.length) {
      console.warn(`[WaterSystem] Invalid wave index: ${index}`);
      return;
    }

    this.waveSources[index].setAmplitude(amplitude);
    this.updateWaveSourceBuffer();
  }

  /**
   * Get current simulation time
   */
  getTime(): number {
    return this.time;
  }
}
