/**
 * WindSystem: Main wind simulation entity.
 *
 * Manages GPU-accelerated wind queries with simplex noise-based
 * spatial and temporal variation.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import type { BindGroupResources } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { V2d } from "../../../core/Vector";
import { WindComputeBindings, WindComputeShader } from "./WindComputeShader";

/**
 * Configuration for wind noise variation.
 */
export interface WindNoiseConfig {
  /** Spatial frequency (default: 0.01 = 100m wavelength) */
  noiseScale: number;
  /** Temporal frequency (default: 0.1 = 10s period) */
  timeScale: number;
  /** Amplitude 0-1 (default: 0.2 = ±20%) */
  variation: number;
}

/**
 * Default wind noise configuration.
 */
export const DEFAULT_WIND_NOISE_CONFIG: WindNoiseConfig = {
  noiseScale: 0.01, // 100m wavelength
  timeScale: 0.1, // 10s period
  variation: 0.2, // ±20%
};

/**
 * Main wind system entity.
 *
 * Provides GPU-accelerated wind queries with noise-based variation.
 * Follows the established TerrainSystem pattern.
 */
export class WindSystem extends BaseEntity {
  static fromGame(game: Game): WindSystem {
    const maybeWindSystem = game.entities.getById("windSystem");
    if (!(maybeWindSystem instanceof WindSystem)) {
      throw new Error("WindSystem not found");
    }
    return maybeWindSystem;
  }

  readonly id = "windSystem";
  readonly tickLayer = "environment";

  private baseWind: V2d;
  private noiseConfig: WindNoiseConfig;
  private time = 0;

  // GPU components
  private computeShader: WindComputeShader | null = null;
  private windParamsBuffer: GPUBuffer | null = null;
  private noiseParamsBuffer: GPUBuffer | null = null;

  /**
   * Create a wind system with the given base wind and noise configuration.
   *
   * @param baseWind - Base wind velocity (m/s)
   * @param noiseConfig - Noise configuration (defaults to DEFAULT_WIND_NOISE_CONFIG)
   */
  constructor(baseWind: V2d, noiseConfig = DEFAULT_WIND_NOISE_CONFIG) {
    super();
    this.baseWind = baseWind;
    this.noiseConfig = { ...noiseConfig };
  }

  /**
   * Initialize GPU resources.
   */
  @on("add")
  async onAdd(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize compute shader
    this.computeShader = new WindComputeShader();
    await this.computeShader.init();

    // Create wind params buffer (uniform: baseWindX, baseWindY, time, padding)
    this.windParamsBuffer = device.createBuffer({
      label: "Wind Params",
      size: 16, // 4 × f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create noise params buffer (uniform: noiseScale, timeScale, variation, padding)
    this.noiseParamsBuffer = device.createBuffer({
      label: "Wind Noise Params",
      size: 16, // 4 × f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Upload initial parameters
    this.uploadWindParams();
    this.uploadNoiseParams();

    console.log("WindSystem: GPU resources initialized");
  }

  /**
   * Update simulation time each tick.
   */
  @on("tick")
  onTick(dt: number): void {
    this.time += dt;
  }

  /**
   * Clean up GPU resources when destroyed.
   */
  @on("destroy")
  onDestroy(): void {
    this.computeShader?.destroy();
    this.windParamsBuffer?.destroy();
    this.noiseParamsBuffer?.destroy();

    this.computeShader = null;
    this.windParamsBuffer = null;
    this.noiseParamsBuffer = null;
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Compute query results for a batch of points.
   * Called by WindQueryManager to run GPU compute.
   *
   * @param pointBuffer - GPU buffer containing query points (vec2f array)
   * @param resultBuffer - GPU buffer to write results (f32 array: stride=4 per point)
   * @param pointCount - Number of points to query
   */
  computeQueryResults(
    pointBuffer: GPUBuffer,
    resultBuffer: GPUBuffer,
    pointCount: number,
  ): void {
    if (!this.computeShader) {
      console.warn(
        "WindSystem: Compute shader not initialized, skipping query",
      );
      return;
    }

    // Skip if no points to query (avoids WebGPU warning)
    if (pointCount === 0) {
      return;
    }

    const device = getWebGPU().device;

    // Upload current time to wind params buffer
    this.uploadWindParams();

    // Create bind group for this query
    const bindGroupResources: BindGroupResources<typeof WindComputeBindings> = {
      queryPoints: { buffer: pointBuffer },
      results: { buffer: resultBuffer },
      windParams: { buffer: this.windParamsBuffer! },
      noiseParams: { buffer: this.noiseParamsBuffer! },
    };

    const bindGroup = this.computeShader.createBindGroup(bindGroupResources);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Query Compute",
    });

    // Dispatch compute shader
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Query Compute Pass",
    });

    this.computeShader.dispatch(computePass, bindGroup, pointCount, 1);

    computePass.end();

    // Submit to GPU
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Get the base wind velocity (unmodified by noise).
   */
  getBaseWind(): V2d {
    return this.baseWind;
  }

  /**
   * Set the base wind velocity.
   */
  setBaseWind(wind: V2d): void {
    this.baseWind = wind;
    this.uploadWindParams();
  }

  /**
   * Get the current noise configuration.
   */
  getNoiseConfig(): WindNoiseConfig {
    return { ...this.noiseConfig };
  }

  /**
   * Set the noise configuration.
   */
  setNoiseConfig(config: Partial<WindNoiseConfig>): void {
    this.noiseConfig = { ...this.noiseConfig, ...config };
    this.uploadNoiseParams();
  }

  // ========================================================================
  // Private GPU Methods
  // ========================================================================

  /**
   * Upload wind parameters to GPU buffer.
   */
  private uploadWindParams(): void {
    if (!this.windParamsBuffer) {
      return;
    }

    const device = getWebGPU().device;
    const data = new Float32Array(4);
    data[0] = this.baseWind.x;
    data[1] = this.baseWind.y;
    data[2] = this.time;
    // data[3] is padding

    device.queue.writeBuffer(this.windParamsBuffer, 0, data);
  }

  /**
   * Upload noise parameters to GPU buffer.
   */
  private uploadNoiseParams(): void {
    if (!this.noiseParamsBuffer) {
      return;
    }

    const device = getWebGPU().device;
    const data = new Float32Array(4);
    data[0] = this.noiseConfig.noiseScale;
    data[1] = this.noiseConfig.timeScale;
    data[2] = this.noiseConfig.variation;
    // data[3] is padding

    device.queue.writeBuffer(this.noiseParamsBuffer, 0, data);
  }
}
