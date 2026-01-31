import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type { BindGroupResources } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { TerrainSystem } from "../terrain/TerrainSystem";
import { WaterComputeBindings, WaterComputeShader } from "./WaterComputeShader";
import { WaterModifier } from "./WaterModifier";
import { WaterModifierBuffer } from "./WaterModifierBuffer";
import { WaveShadow } from "./WaveShadow";
import { WaveSource, type WaveSourceConfig } from "./WaveSource";

/**
 * Configuration for the water system
 */
export interface WaterSystemConfig {
  /** Array of wave source configurations */
  waves: WaveSourceConfig[];
  /** Tide configuration (optional) */
  tide?: {
    /** Tide amplitude in meters */
    amplitude: number;
    /** Tide period in seconds */
    period: number;
  };
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
  private tideAmplitude = 0;
  private tidePeriod = 3600;

  // Shadow and modifier systems
  private waveShadows: WaveShadow[] = [];
  private modifierBuffer: WaterModifierBuffer | null = null;

  // GPU resources
  private computeShader: WaterComputeShader | null = null;
  private waveSourceBuffer: GPUBuffer | null = null;
  private waterParamsBuffer: GPUBuffer | null = null;
  private terrainResultBuffer: GPUBuffer | null = null;
  private modifierParamsBuffer: GPUBuffer | null = null;
  private shadowSampler: GPUSampler | null = null;
  private dummyShadowTexture: GPUTexture | null = null;

  constructor(config: WaterSystemConfig) {
    super();
    this.waveSources = config.waves.map(
      (waveConfig) => new WaveSource(waveConfig),
    );
    this.tideAmplitude = config.tide?.amplitude ?? 0;
    this.tidePeriod = config.tide?.period ?? 3600; // Default 1 hour
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

      // Create WaveShadow entities (one per wave source)
      for (let i = 0; i < this.waveSources.length; i++) {
        const shadow = new WaveShadow(this.waveSources[i], i);
        this.addChild(shadow);
        this.waveShadows.push(shadow);
      }

      // Create water modifier buffer
      this.modifierBuffer = new WaterModifierBuffer();

      // Create terrain result buffer (stride=4: height, normalX, normalY, terrainType)
      const maxPoints = 8192;
      this.terrainResultBuffer = device.createBuffer({
        label: "WaterSystem Terrain Results",
        size: maxPoints * 4 * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      // Create modifier params uniform buffer
      // WebGPU requires minimum 32 bytes for uniform buffers
      this.modifierParamsBuffer = device.createBuffer({
        label: "WaterSystem Modifier Params",
        size: 32, // Minimum required by WebGPU for uniform buffers
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // Create shadow sampler (linear filtering for smooth shadows)
      this.shadowSampler = device.createSampler({
        label: "WaterSystem Shadow Sampler",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
      });

      // Create dummy shadow texture (1x1 black) for use until WaveShadows are ready
      try {
        this.dummyShadowTexture = device.createTexture({
          label: "WaterSystem Dummy Shadow",
          size: {
            width: 1,
            height: 1,
            depthOrArrayLayers: Math.max(this.waveSources.length, 1),
          },
          format: "rg32float",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        // Initialize dummy texture with zeros (no shadow)
        const dummyData = new Float32Array(2); // rg32float = 2 floats per pixel
        dummyData[0] = 0.0; // R = 0 (no shadow)
        dummyData[1] = 1.0; // G = 1 (far from edge)
        for (let i = 0; i < this.waveSources.length; i++) {
          device.queue.writeTexture(
            { texture: this.dummyShadowTexture, origin: [0, 0, i] },
            dummyData,
            { bytesPerRow: 8, rowsPerImage: 1 }, // 2 floats × 4 bytes = 8 bytes
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          );
        }
      } catch (error) {
        console.error(
          "[WaterSystem] Failed to create dummy shadow texture:",
          error,
        );
        throw error;
      }

      this.isInitialized = true;
    } catch (error) {
      console.error("[WaterSystem] Failed to initialize:", error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Handle shadow computation completion
   */
  @on("shadowsComputed")
  onShadowsComputed({
    waveIndex,
    polygonCount,
  }: {
    waveIndex: number;
    polygonCount: number;
  }): void {
    console.log(
      `[WaterSystem] Received shadowsComputed event for wave ${waveIndex}: ${polygonCount} polygon(s)`,
    );
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

    this.terrainResultBuffer?.destroy();
    this.terrainResultBuffer = null;

    this.modifierParamsBuffer?.destroy();
    this.modifierParamsBuffer = null;

    this.modifierBuffer?.destroy();
    this.modifierBuffer = null;

    this.dummyShadowTexture?.destroy();
    this.dummyShadowTexture = null;

    // WaveShadow entities will be destroyed by entity system
    this.waveShadows = [];
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
      !this.waterParamsBuffer ||
      !this.terrainResultBuffer ||
      !this.modifierParamsBuffer ||
      !this.modifierBuffer ||
      !this.shadowSampler
    ) {
      console.warn("[WaterSystem] GPU resources not initialized");
      return;
    }

    const device = getWebGPU().device;

    // 1. Query terrain heights for same points
    this.queryTerrainHeights(pointBuffer, pointCount);

    // 2. Update water modifiers
    this.updateModifiers();

    // 3. Request shadow tiles (TODO: determine query region from points)
    // For now, skip tile requests - will be added when needed

    // 4. Update water params before dispatch
    this.updateWaterParamsBuffer();

    // 5. Get shadow textures from WaveShadow entities (or use dummy if not ready)
    let shadowTexture: GPUTexture = this.dummyShadowTexture!;
    if (this.waveShadows.length > 0) {
      const firstShadowTexture = this.waveShadows[0].getShadowTexture();
      if (firstShadowTexture) {
        shadowTexture = firstShadowTexture;
      }
    }

    const shadowTextureView = shadowTexture.createView({
      dimension: "2d-array",
    });

    // 6. Create bind group with all 9 bindings
    const bindGroupResources: BindGroupResources<typeof WaterComputeBindings> =
      {
        queryPoints: { buffer: pointBuffer },
        results: { buffer: resultBuffer },
        waveSources: { buffer: this.waveSourceBuffer },
        waterParams: { buffer: this.waterParamsBuffer },
        terrainResults: { buffer: this.terrainResultBuffer },
        shadowTextures: shadowTextureView,
        shadowSampler: this.shadowSampler,
        modifiers: { buffer: this.modifierBuffer.getBuffer()! },
        modifierParams: { buffer: this.modifierParamsBuffer },
      };

    const bindGroup = this.computeShader.createBindGroup(bindGroupResources);

    // 7. Create command encoder and compute pass
    const commandEncoder = device.createCommandEncoder({
      label: "WaterSystem Query Compute",
    });

    const computePass = commandEncoder.beginComputePass({
      label: "WaterSystem Compute Pass",
    });

    // 8. Dispatch compute shader
    this.computeShader.dispatch(computePass, bindGroup, pointCount, 1);

    computePass.end();

    // 9. Submit to GPU queue
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Query terrain heights for water query points.
   * Uses TerrainSystem GPU compute to get terrain data.
   */
  private queryTerrainHeights(
    pointBuffer: GPUBuffer,
    pointCount: number,
  ): void {
    if (!this.terrainResultBuffer) return;

    const terrainSystem =
      this.game.entities.tryGetSingleton<TerrainSystem>(TerrainSystem);

    if (!terrainSystem) {
      // No terrain system - fill with default deep water (-100m)
      const device = getWebGPU().device;
      const results = new Float32Array(pointCount * 4);
      for (let i = 0; i < pointCount; i++) {
        results[i * 4] = -100.0; // height
        results[i * 4 + 1] = 0.0; // normalX
        results[i * 4 + 2] = 1.0; // normalY (up)
        results[i * 4 + 3] = 0.0; // terrainType
      }
      device.queue.writeBuffer(this.terrainResultBuffer, 0, results);
      return;
    }

    // Use TerrainSystem GPU compute to query heights
    terrainSystem.computeQueryResults(
      pointBuffer,
      this.terrainResultBuffer,
      pointCount,
    );
  }

  /**
   * Update water modifiers by collecting all WaterModifier entities
   * and uploading to GPU.
   */
  private updateModifiers(): void {
    if (!this.modifierBuffer || !this.modifierParamsBuffer) return;

    // Collect all water modifiers from game
    const modifiers = [...this.game.entities.byConstructor(WaterModifier)];

    // Update buffer
    this.modifierBuffer.update(modifiers);

    // Update uniform with active count
    const device = getWebGPU().device;
    const paramsArray = new Uint32Array([
      this.modifierBuffer.getActiveCount(),
      0, // padding
      0, // padding
      0, // padding
    ]);
    device.queue.writeBuffer(this.modifierParamsBuffer, 0, paramsArray);
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
   * Update water params buffer with current time, wave count, and tide height
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
      this.getTideHeight(), // current tide height
      0, // padding
    ]);

    device.queue.writeBuffer(this.waterParamsBuffer, 0, data);
  }

  /**
   * Get the current tide height using a simple sinusoidal model.
   *
   * @returns Tide height in meters (positive = high tide, negative = low tide)
   */
  getTideHeight(): number {
    if (this.tideAmplitude === 0) {
      return 0;
    }

    // Simple sinusoidal tide: amplitude * sin(2π * time / period)
    const phase = (2 * Math.PI * this.time) / this.tidePeriod;
    return this.tideAmplitude * Math.sin(phase);
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

  /**
   * Get wave source GPU buffer for rendering
   */
  getWaveSourceBuffer(): GPUBuffer | null {
    return this.waveSourceBuffer;
  }

  /**
   * Get shadow textures from WaveShadow entities for rendering
   */
  getShadowTextures(): GPUTexture | null {
    // Return the first shadow texture if available, otherwise dummy
    if (this.waveShadows.length > 0) {
      const shadowTexture = this.waveShadows[0].getShadowTexture();
      if (shadowTexture) {
        return shadowTexture;
      }
    }
    return this.dummyShadowTexture;
  }

  /**
   * Get water modifier GPU buffer for rendering
   */
  getModifierBuffer(): GPUBuffer | null {
    return this.modifierBuffer?.getBuffer() ?? null;
  }

  /**
   * Get water params GPU buffer for rendering
   */
  getWaterParamsBuffer(): GPUBuffer | null {
    return this.waterParamsBuffer;
  }

  /**
   * Get modifier params GPU buffer for rendering
   */
  getModifierParamsBuffer(): GPUBuffer | null {
    return this.modifierParamsBuffer;
  }

  /**
   * Get shadow sampler for rendering
   */
  getShadowSampler(): GPUSampler | null {
    return this.shadowSampler;
  }
}
