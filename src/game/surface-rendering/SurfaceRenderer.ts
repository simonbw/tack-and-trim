/**
 * Surface rendering entity - Multi-pass version.
 *
 * Renders the ocean and terrain using three GPU passes:
 * 1. Water Height (compute) - Gerstner waves + modifiers
 * 2. Terrain Height (compute) - Contour-based height
 * 3. Surface Composite (fragment) - Normals + lighting
 *
 * This separation enables:
 * - Per-pass GPU timing for performance diagnosis
 * - Future optimizations (lower resolution, caching, etc.)
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { Matrix3 } from "../../core/graphics/Matrix3";
import { type UniformInstance } from "../../core/graphics/UniformStruct";
import type { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import type { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { TimeOfDay } from "../time/TimeOfDay";
import {
  WavePhysicsResources,
  type Viewport,
} from "../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WaterResources } from "../world/water/WaterResources";
import { WAVE_COMPONENTS } from "../world/water/WaterConstants";
import { createWaterHeightShader } from "./WaterHeightShader";
import { createTerrainHeightShader } from "./TerrainHeightShader";
import { createSurfaceCompositeShader } from "./SurfaceCompositeShader";
import { WaterHeightUniforms } from "./WaterHeightUniforms";
import { TerrainHeightUniforms } from "./TerrainHeightUniforms";
import { SurfaceCompositeUniforms } from "./SurfaceCompositeUniforms";

// Re-export for backwards compatibility
export { SurfaceCompositeUniforms as SurfaceUniforms } from "./SurfaceCompositeUniforms";

// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Surface renderer entity using multi-pass rendering.
 */
export class SurfaceRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private initialized = false;

  // Shaders for each pass
  private waterHeightShader: ComputeShader | null = null;
  private terrainHeightShader: ComputeShader | null = null;
  private compositeShader: FullscreenShader | null = null;

  // Intermediate textures
  private waterHeightTexture: GPUTexture | null = null;
  private waterHeightView: GPUTextureView | null = null;
  private terrainHeightTexture: GPUTexture | null = null;
  private terrainHeightView: GPUTextureView | null = null;

  // Uniform buffers
  private waterHeightUniformBuffer: GPUBuffer | null = null;
  private terrainHeightUniformBuffer: GPUBuffer | null = null;
  private compositeUniformBuffer: GPUBuffer | null = null;

  // Uniform instances
  private waterHeightUniforms: UniformInstance<
    typeof WaterHeightUniforms.fields
  > | null = null;
  private terrainHeightUniforms: UniformInstance<
    typeof TerrainHeightUniforms.fields
  > | null = null;
  private compositeUniforms: UniformInstance<
    typeof SurfaceCompositeUniforms.fields
  > | null = null;

  // Samplers
  private heightSampler: GPUSampler | null = null;
  private shadowSampler: GPUSampler | null = null;

  // Placeholder resources
  private placeholderShadowTexture: GPUTexture | null = null;
  private placeholderShadowView: GPUTextureView | null = null;
  private placeholderWaveDataBuffer: GPUBuffer | null = null;
  private placeholderModifiersBuffer: GPUBuffer | null = null;
  private placeholderVertexBuffer: GPUBuffer | null = null;
  private placeholderContoursBuffer: GPUBuffer | null = null;
  private placeholderChildrenBuffer: GPUBuffer | null = null;

  // Bind groups (recreated when resources change)
  private waterHeightBindGroup: GPUBindGroup | null = null;
  private terrainHeightBindGroup: GPUBindGroup | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;

  // Track last resources
  private lastTextureWidth = 0;
  private lastTextureHeight = 0;
  private lastTerrainVersion = -1;
  private lastShadowView: GPUTextureView | null = null;
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastModifiersBuffer: GPUBuffer | null = null;
  private lastVertexBuffer: GPUBuffer | null = null;
  private lastContoursBuffer: GPUBuffer | null = null;

  constructor() {
    super();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;

      // Create shaders
      this.waterHeightShader = createWaterHeightShader();
      this.terrainHeightShader = createTerrainHeightShader();
      this.compositeShader = createSurfaceCompositeShader();

      await Promise.all([
        this.waterHeightShader.init(),
        this.terrainHeightShader.init(),
        this.compositeShader.init(),
      ]);

      // Create uniform buffers
      this.waterHeightUniformBuffer = device.createBuffer({
        size: WaterHeightUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Water Height Uniform Buffer",
      });
      this.terrainHeightUniformBuffer = device.createBuffer({
        size: TerrainHeightUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Terrain Height Uniform Buffer",
      });
      this.compositeUniformBuffer = device.createBuffer({
        size: SurfaceCompositeUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Surface Composite Uniform Buffer",
      });

      // Create uniform instances
      this.waterHeightUniforms = WaterHeightUniforms.create();
      this.terrainHeightUniforms = TerrainHeightUniforms.create();
      this.compositeUniforms = SurfaceCompositeUniforms.create();

      // Set default composite values
      this.compositeUniforms.set.shallowThreshold(SHALLOW_WATER_THRESHOLD);
      this.compositeUniforms.set.hasTerrainData(0);

      // Create samplers
      this.heightSampler = device.createSampler({
        magFilter: "nearest",
        minFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        label: "Height Texture Sampler",
      });

      this.shadowSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        label: "Shadow Texture Sampler",
      });

      // Create placeholder shadow texture
      this.placeholderShadowTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rg16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: "Placeholder Shadow Texture",
      });
      this.placeholderShadowView = this.placeholderShadowTexture.createView();

      // Write full energy (1.0, 1.0) to placeholder
      const shadowData = new Uint16Array([0x3c00, 0x3c00]);
      device.queue.writeTexture(
        { texture: this.placeholderShadowTexture },
        shadowData,
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );

      // Create placeholder buffers
      this.placeholderWaveDataBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Wave Data Buffer",
      });
      this.placeholderModifiersBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Modifiers Buffer",
      });
      this.placeholderVertexBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Control Points Buffer",
      });
      this.placeholderContoursBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Contours Buffer",
      });
      this.placeholderChildrenBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Children Buffer",
      });

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize SurfaceRenderer:", error);
    }
  }

  @on("add")
  onAdd() {
    this.ensureInitialized();
  }

  /**
   * Ensure intermediate textures exist and match screen size.
   */
  private ensureTextures(width: number, height: number): void {
    if (this.lastTextureWidth === width && this.lastTextureHeight === height) {
      return;
    }

    const device = getWebGPU().device;

    // Destroy old textures
    this.waterHeightTexture?.destroy();
    this.terrainHeightTexture?.destroy();

    // Create water height texture
    this.waterHeightTexture = device.createTexture({
      size: { width, height },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Water Height Texture",
    });
    this.waterHeightView = this.waterHeightTexture.createView();

    // Create terrain height texture
    this.terrainHeightTexture = device.createTexture({
      size: { width, height },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Height Texture",
    });
    this.terrainHeightView = this.terrainHeightTexture.createView();

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    // Force bind group recreation
    this.waterHeightBindGroup = null;
    this.terrainHeightBindGroup = null;
    this.compositeBindGroup = null;
  }

  /**
   * Get viewport expanded by the given margin factor.
   */
  private getExpandedViewport(margin: number): Viewport {
    const camera = this.game.camera;
    const worldViewport = camera.getWorldViewport();

    const marginX = worldViewport.width * margin;
    const marginY = worldViewport.height * margin;

    return {
      left: worldViewport.left - marginX,
      top: worldViewport.top - marginY,
      width: worldViewport.width + marginX * 2,
      height: worldViewport.height + marginY * 2,
    };
  }

  /**
   * Update uniforms for water height pass.
   */
  private updateWaterHeightUniforms(
    viewport: Viewport,
    currentTime: number,
    width: number,
    height: number,
    waterResources: WaterResources | undefined,
  ): void {
    if (!this.waterHeightUniforms) return;

    this.waterHeightUniforms.set.screenWidth(width);
    this.waterHeightUniforms.set.screenHeight(height);
    this.waterHeightUniforms.set.viewportLeft(viewport.left);
    this.waterHeightUniforms.set.viewportTop(viewport.top);
    this.waterHeightUniforms.set.viewportWidth(viewport.width);
    this.waterHeightUniforms.set.viewportHeight(viewport.height);
    this.waterHeightUniforms.set.time(currentTime);

    if (waterResources) {
      this.waterHeightUniforms.set.tideHeight(waterResources.getTideHeight());
      this.waterHeightUniforms.set.modifierCount(
        waterResources.getModifierCount(),
      );
      this.waterHeightUniforms.set.waveSourceDirection(
        waterResources.getAnalyticalConfig().waveSourceDirection,
      );
    } else {
      this.waterHeightUniforms.set.tideHeight(0);
      this.waterHeightUniforms.set.modifierCount(0);
      this.waterHeightUniforms.set.waveSourceDirection(WAVE_COMPONENTS[0][2]);
    }
  }

  /**
   * Update uniforms for terrain height pass.
   */
  private updateTerrainHeightUniforms(
    viewport: Viewport,
    width: number,
    height: number,
    terrainResources: TerrainResources | undefined,
  ): void {
    if (!this.terrainHeightUniforms) return;

    this.terrainHeightUniforms.set.screenWidth(width);
    this.terrainHeightUniforms.set.screenHeight(height);
    this.terrainHeightUniforms.set.viewportLeft(viewport.left);
    this.terrainHeightUniforms.set.viewportTop(viewport.top);
    this.terrainHeightUniforms.set.viewportWidth(viewport.width);
    this.terrainHeightUniforms.set.viewportHeight(viewport.height);
    this.terrainHeightUniforms.set.contourCount(
      terrainResources?.getContourCount() ?? 0,
    );
  }

  /**
   * Update uniforms for composite pass.
   */
  private updateCompositeUniforms(
    viewport: Viewport,
    currentTime: number,
    width: number,
    height: number,
    cameraMatrix: Matrix3,
    waterResources: WaterResources | undefined,
    terrainResources: TerrainResources | undefined,
  ): void {
    if (!this.compositeUniforms) return;

    this.compositeUniforms.set.cameraMatrix(cameraMatrix);
    this.compositeUniforms.set.screenWidth(width);
    this.compositeUniforms.set.screenHeight(height);
    this.compositeUniforms.set.viewportLeft(viewport.left);
    this.compositeUniforms.set.viewportTop(viewport.top);
    this.compositeUniforms.set.viewportWidth(viewport.width);
    this.compositeUniforms.set.viewportHeight(viewport.height);
    this.compositeUniforms.set.time(currentTime);
    this.compositeUniforms.set.tideHeight(waterResources?.getTideHeight() ?? 0);
    this.compositeUniforms.set.hasTerrainData(terrainResources ? 1 : 0);
  }

  /**
   * Ensure bind groups are up to date.
   */
  private ensureBindGroups(
    waterResources: WaterResources | undefined,
    terrainResources: TerrainResources | undefined,
    shadowTextureView: GPUTextureView,
  ): void {
    // Get actual buffers or use placeholders
    const waveDataBuffer =
      waterResources?.waveDataBuffer ?? this.placeholderWaveDataBuffer!;
    const modifiersBuffer =
      waterResources?.modifiersBuffer ?? this.placeholderModifiersBuffer!;
    const vertexBuffer =
      terrainResources?.vertexBuffer ?? this.placeholderVertexBuffer!;
    const contoursBuffer =
      terrainResources?.contourBuffer ?? this.placeholderContoursBuffer!;
    const childrenBuffer =
      terrainResources?.childrenBuffer ?? this.placeholderChildrenBuffer!;

    const terrainVersion = terrainResources?.getVersion() ?? -1;
    const needsRebuild =
      !this.waterHeightBindGroup ||
      !this.terrainHeightBindGroup ||
      !this.compositeBindGroup ||
      this.lastShadowView !== shadowTextureView ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
      this.lastModifiersBuffer !== modifiersBuffer ||
      this.lastVertexBuffer !== vertexBuffer ||
      this.lastContoursBuffer !== contoursBuffer ||
      this.lastTerrainVersion !== terrainVersion;

    if (!needsRebuild) return;

    // Water height bind group
    if (
      this.waterHeightShader &&
      this.waterHeightUniformBuffer &&
      this.waterHeightView
    ) {
      this.waterHeightBindGroup = this.waterHeightShader.createBindGroup({
        params: { buffer: this.waterHeightUniformBuffer },
        waveData: { buffer: waveDataBuffer },
        modifiers: { buffer: modifiersBuffer },
        outputTexture: this.waterHeightView,
      });
    }

    // Terrain height bind group
    if (
      this.terrainHeightShader &&
      this.terrainHeightUniformBuffer &&
      this.terrainHeightView
    ) {
      this.terrainHeightBindGroup = this.terrainHeightShader.createBindGroup({
        params: { buffer: this.terrainHeightUniformBuffer },
        vertices: { buffer: vertexBuffer },
        contours: { buffer: contoursBuffer },
        children: { buffer: childrenBuffer },
        outputTexture: this.terrainHeightView,
      });
    }

    // Composite bind group
    if (
      this.compositeShader &&
      this.compositeUniformBuffer &&
      this.waterHeightView &&
      this.terrainHeightView &&
      this.heightSampler &&
      this.shadowSampler
    ) {
      this.compositeBindGroup = this.compositeShader.createBindGroup({
        params: { buffer: this.compositeUniformBuffer },
        waterHeightTexture: this.waterHeightView,
        terrainHeightTexture: this.terrainHeightView,
        shadowTexture: shadowTextureView,
        heightSampler: this.heightSampler,
        shadowSampler: this.shadowSampler,
      });
    }

    // Update tracking
    this.lastShadowView = shadowTextureView;
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastModifiersBuffer = modifiersBuffer;
    this.lastVertexBuffer = vertexBuffer;
    this.lastContoursBuffer = contoursBuffer;
    this.lastTerrainVersion = terrainVersion;
  }

  @on("render")
  onRender(_event: { dt: number; draw: Draw }) {
    if (!this.initialized) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const gpuProfiler = renderer.getGpuProfiler();
    const device = getWebGPU().device;

    const width = renderer.getWidth();
    const height = renderer.getHeight();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);

    // Use TimeOfDay as unified time source
    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    const currentTime = timeOfDay
      ? timeOfDay.getTimeInSeconds()
      : this.game.elapsedUnpausedTime;

    // Get resources
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources);

    // Update shadow texture
    if (wavePhysicsResources?.isInitialized()) {
      wavePhysicsResources.updateShadowTexture(
        expandedViewport,
        gpuProfiler?.getTimestampWrites("surface.shadow"),
      );
    }

    const shadowTextureView =
      wavePhysicsResources?.getShadowTextureView() ??
      this.placeholderShadowView!;

    // Ensure intermediate textures
    this.ensureTextures(width, height);

    // Get camera matrix
    const cameraMatrix = camera.getMatrix().clone().invert();

    // Update all uniforms
    this.updateWaterHeightUniforms(
      expandedViewport,
      currentTime,
      width,
      height,
      waterResources,
    );
    this.updateTerrainHeightUniforms(
      expandedViewport,
      width,
      height,
      terrainResources,
    );
    this.updateCompositeUniforms(
      expandedViewport,
      currentTime,
      width,
      height,
      cameraMatrix,
      waterResources,
      terrainResources,
    );

    // Upload uniforms
    this.waterHeightUniforms?.uploadTo(this.waterHeightUniformBuffer!);
    this.terrainHeightUniforms?.uploadTo(this.terrainHeightUniformBuffer!);
    this.compositeUniforms?.uploadTo(this.compositeUniformBuffer!);

    // Ensure bind groups
    this.ensureBindGroups(waterResources, terrainResources, shadowTextureView);

    // === Pass 1: Water Height Compute ===
    if (this.waterHeightShader && this.waterHeightBindGroup) {
      const commandEncoder = device.createCommandEncoder({
        label: "Water Height Compute",
      });
      const computePass = commandEncoder.beginComputePass({
        label: "Water Height Compute Pass",
        timestampWrites:
          gpuProfiler?.getComputeTimestampWrites("surface.water"),
      });
      this.waterHeightShader.dispatch(
        computePass,
        this.waterHeightBindGroup,
        width,
        height,
      );
      computePass.end();
      device.queue.submit([commandEncoder.finish()]);
    }

    // === Pass 2: Terrain Height Compute ===
    if (this.terrainHeightShader && this.terrainHeightBindGroup) {
      const commandEncoder = device.createCommandEncoder({
        label: "Terrain Height Compute",
      });
      const computePass = commandEncoder.beginComputePass({
        label: "Terrain Height Compute Pass",
        timestampWrites:
          gpuProfiler?.getComputeTimestampWrites("surface.terrain"),
      });
      this.terrainHeightShader.dispatch(
        computePass,
        this.terrainHeightBindGroup,
        width,
        height,
      );
      computePass.end();
      device.queue.submit([commandEncoder.finish()]);
    }

    // === Pass 3: Surface Composite ===
    const renderPass = renderer.getCurrentRenderPass();
    if (renderPass && this.compositeShader && this.compositeBindGroup) {
      this.compositeShader.render(renderPass, this.compositeBindGroup);
    }
  }

  /**
   * Get the terrain height texture view for debug visualization.
   * Returns null if not initialized or textures not created yet.
   */
  getTerrainHeightTextureView(): GPUTextureView | null {
    return this.terrainHeightView;
  }

  @on("destroy")
  onDestroy(): void {
    this.waterHeightShader?.destroy();
    this.terrainHeightShader?.destroy();
    this.compositeShader?.destroy();
    this.waterHeightTexture?.destroy();
    this.terrainHeightTexture?.destroy();
    this.waterHeightUniformBuffer?.destroy();
    this.terrainHeightUniformBuffer?.destroy();
    this.compositeUniformBuffer?.destroy();
    this.placeholderShadowTexture?.destroy();
    this.placeholderWaveDataBuffer?.destroy();
    this.placeholderModifiersBuffer?.destroy();
    this.placeholderVertexBuffer?.destroy();
    this.placeholderContoursBuffer?.destroy();
    this.placeholderChildrenBuffer?.destroy();
  }
}
