/**
 * Surface rendering entity - Multi-pass version.
 *
 * Renders the ocean and terrain using three GPU passes:
 * 1. Terrain Screen (compute) - Sample tile atlas → screen-space terrain height
 * 2. Water Height (compute) - Gerstner waves + modifiers (uses terrain height for refraction/shoaling)
 * 3. Surface Composite (fragment) - Normals + lighting
 *
 * This separation enables:
 * - Per-pass GPU timing for performance diagnosis
 * - Future optimizations (lower resolution, caching, etc.)
 * - Terrain height available to water height shader for refraction and shoaling
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { Matrix3 } from "../../core/graphics/Matrix3";
import { type UniformInstance } from "../../core/graphics/UniformStruct";
import type { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import type { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { MAX_WAVE_SOURCES } from "../wave-physics/WavePhysicsManager";
import { TimeOfDay } from "../time/TimeOfDay";
import {
  WavePhysicsResources,
  type Viewport,
} from "../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WaterResources } from "../world/water/WaterResources";
import { createWaterHeightShader } from "./WaterHeightShader";
import { createSurfaceCompositeShader } from "./SurfaceCompositeShader";
import { createTerrainScreenShader } from "./TerrainScreenShader";
import { WaterHeightUniforms } from "./WaterHeightUniforms";
import { SurfaceCompositeUniforms } from "./SurfaceCompositeUniforms";
import { TerrainScreenUniforms } from "./TerrainScreenUniforms";
import { LODTerrainTileCache } from "./LODTerrainTileCache";
import { WetnessRenderPipeline } from "./WetnessRenderPipeline";

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
  private terrainScreenShader: ComputeShader | null = null;
  private waterHeightShader: ComputeShader | null = null;
  private compositeShader: FullscreenShader | null = null;

  // LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
  private terrainTileCache: LODTerrainTileCache | null = null;

  // Wetness render pipeline (tracks sand wetness over time)
  private wetnessPipeline: WetnessRenderPipeline | null = null;

  // Intermediate textures
  private terrainHeightTexture: GPUTexture | null = null;
  private terrainHeightView: GPUTextureView | null = null;
  private waterHeightTexture: GPUTexture | null = null;
  private waterHeightView: GPUTextureView | null = null;

  // Wave field texture array (rgba16float, one layer per wave source)
  private waveFieldTexture: GPUTexture | null = null;
  private waveFieldTextureView: GPUTextureView | null = null;
  private waveFieldSampler: GPUSampler | null = null;

  // Uniform buffers
  private terrainScreenUniformBuffer: GPUBuffer | null = null;
  private waterHeightUniformBuffer: GPUBuffer | null = null;
  private compositeUniformBuffer: GPUBuffer | null = null;

  // Uniform instances
  private terrainScreenUniforms: UniformInstance<
    typeof TerrainScreenUniforms.fields
  > | null = null;
  private waterHeightUniforms: UniformInstance<
    typeof WaterHeightUniforms.fields
  > | null = null;
  private compositeUniforms: UniformInstance<
    typeof SurfaceCompositeUniforms.fields
  > | null = null;

  // Samplers
  private heightSampler: GPUSampler | null = null;

  // Bind groups (recreated when resources change)
  private terrainScreenBindGroup: GPUBindGroup | null = null;
  private waterHeightBindGroup: GPUBindGroup | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;

  // Track last resources
  private lastTextureWidth = 0;
  private lastTextureHeight = 0;
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastModifiersBuffer: GPUBuffer | null = null;
  private lastTerrainAtlasView: GPUTextureView | null = null;
  private lastWaveFieldTextureView: GPUTextureView | null = null;

  constructor() {
    super();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;

      // Create shaders
      this.terrainScreenShader = createTerrainScreenShader();
      this.waterHeightShader = createWaterHeightShader();
      this.compositeShader = createSurfaceCompositeShader();

      // Create LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
      // Supports zoom range 0.02 to 1.0+ by using progressively larger world units per tile
      this.terrainTileCache = new LODTerrainTileCache();

      // Create wetness render pipeline (will be sized when textures are created)
      // Using placeholder size - will be recreated when ensureTextures is called
      this.wetnessPipeline = new WetnessRenderPipeline(1, 1);

      await Promise.all([
        this.terrainScreenShader.init(),
        this.waterHeightShader.init(),
        this.compositeShader.init(),
        this.terrainTileCache.init(),
        this.wetnessPipeline.init(),
      ]);

      // Create uniform buffers
      this.terrainScreenUniformBuffer = device.createBuffer({
        size: TerrainScreenUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Terrain Screen Uniform Buffer",
      });
      this.waterHeightUniformBuffer = device.createBuffer({
        size: WaterHeightUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Water Height Uniform Buffer",
      });
      this.compositeUniformBuffer = device.createBuffer({
        size: SurfaceCompositeUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Surface Composite Uniform Buffer",
      });

      // Create uniform instances
      this.terrainScreenUniforms = TerrainScreenUniforms.create();
      this.waterHeightUniforms = WaterHeightUniforms.create();
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

      // Create wave field sampler (linear filtering for smooth interpolation)
      this.waveFieldSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        label: "Wave Field Sampler",
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
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture?.destroy();

    // Destroy old wetness pipeline (will be recreated with new size)
    this.wetnessPipeline?.destroy();

    // Create terrain height texture (screen-space, sampled from tile atlas)
    this.terrainHeightTexture = device.createTexture({
      size: { width, height },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Height Texture",
    });
    this.terrainHeightView = this.terrainHeightTexture.createView();

    // Create water height texture
    this.waterHeightTexture = device.createTexture({
      size: { width, height },
      format: "rg32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Water Height Texture",
    });
    this.waterHeightView = this.waterHeightTexture.createView();

    // Create wave field texture array (one layer per wave source)
    this.waveFieldTexture = device.createTexture({
      size: { width, height, depthOrArrayLayers: MAX_WAVE_SOURCES },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Wave Field Texture",
    });
    this.waveFieldTextureView = this.waveFieldTexture.createView({
      dimension: "2d-array",
      label: "Wave Field Texture View",
    });

    // Recreate wetness pipeline with new texture size
    this.wetnessPipeline = new WetnessRenderPipeline(width, height);
    this.wetnessPipeline.init();

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    // Force bind group recreation
    this.terrainScreenBindGroup = null;
    this.waterHeightBindGroup = null;
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
   * Update uniforms for terrain screen pass.
   */
  private updateTerrainScreenUniforms(
    viewport: Viewport,
    width: number,
    height: number,
  ): void {
    if (!this.terrainScreenUniforms || !this.terrainTileCache) return;

    this.terrainScreenUniforms.set.screenWidth(width);
    this.terrainScreenUniforms.set.screenHeight(height);
    this.terrainScreenUniforms.set.viewportLeft(viewport.left);
    this.terrainScreenUniforms.set.viewportTop(viewport.top);
    this.terrainScreenUniforms.set.viewportWidth(viewport.width);
    this.terrainScreenUniforms.set.viewportHeight(viewport.height);

    // Set terrain tile atlas parameters
    const atlasInfo = this.terrainTileCache.getAtlasInfo();
    this.terrainScreenUniforms.set.atlasTileSize(atlasInfo.tileSize);
    this.terrainScreenUniforms.set.atlasTilesX(atlasInfo.tilesX);
    this.terrainScreenUniforms.set.atlasTilesY(atlasInfo.tilesY);
    this.terrainScreenUniforms.set.atlasWorldUnitsPerTile(
      atlasInfo.worldUnitsPerTile,
    );
  }

  /**
   * Update uniforms for water height pass.
   */
  private updateWaterHeightUniforms(
    viewport: Viewport,
    currentTime: number,
    width: number,
    height: number,
    waterResources: WaterResources,
  ): void {
    if (!this.waterHeightUniforms) return;

    this.waterHeightUniforms.set.screenWidth(width);
    this.waterHeightUniforms.set.screenHeight(height);
    this.waterHeightUniforms.set.viewportLeft(viewport.left);
    this.waterHeightUniforms.set.viewportTop(viewport.top);
    this.waterHeightUniforms.set.viewportWidth(viewport.width);
    this.waterHeightUniforms.set.viewportHeight(viewport.height);
    this.waterHeightUniforms.set.time(currentTime);
    this.waterHeightUniforms.set.tideHeight(waterResources.getTideHeight());
    this.waterHeightUniforms.set.modifierCount(
      waterResources.getModifierCount(),
    );
    this.waterHeightUniforms.set.numWaves(waterResources.getNumWaves());
  }

  /**
   * Update uniforms for composite pass.
   */
  private updateCompositeUniforms(
    expandedViewport: Viewport,
    cameraViewport: Viewport,
    currentTime: number,
    width: number,
    height: number,
    cameraMatrix: Matrix3,
    waterResources: WaterResources,
    terrainResources: TerrainResources,
  ): void {
    if (!this.compositeUniforms || !this.terrainTileCache) return;

    this.compositeUniforms.set.cameraMatrix(cameraMatrix);
    this.compositeUniforms.set.screenWidth(width);
    this.compositeUniforms.set.screenHeight(height);
    // Expanded viewport for height texture UV lookups
    this.compositeUniforms.set.viewportLeft(expandedViewport.left);
    this.compositeUniforms.set.viewportTop(expandedViewport.top);
    this.compositeUniforms.set.viewportWidth(expandedViewport.width);
    this.compositeUniforms.set.viewportHeight(expandedViewport.height);
    this.compositeUniforms.set.time(currentTime);
    this.compositeUniforms.set.tideHeight(waterResources.getTideHeight());
    this.compositeUniforms.set.hasTerrainData(terrainResources ? 1 : 0);

    // Set terrain tile atlas parameters
    const atlasInfo = this.terrainTileCache.getAtlasInfo();
    this.compositeUniforms.set.atlasTileSize(atlasInfo.tileSize);
    this.compositeUniforms.set.atlasTilesX(atlasInfo.tilesX);
    this.compositeUniforms.set.atlasTilesY(atlasInfo.tilesY);
    this.compositeUniforms.set.atlasWorldUnitsPerTile(
      atlasInfo.worldUnitsPerTile,
    );

    // Camera viewport for clip-to-world mapping (matches camera matrix)
    this.compositeUniforms.set.cameraLeft(cameraViewport.left);
    this.compositeUniforms.set.cameraTop(cameraViewport.top);
    this.compositeUniforms.set.cameraWidth(cameraViewport.width);
    this.compositeUniforms.set.cameraHeight(cameraViewport.height);
  }

  /**
   * Ensure bind groups are up to date.
   */
  private ensureBindGroups(
    waterResources: WaterResources,
    terrainAtlasView: GPUTextureView,
  ): void {
    const waveDataBuffer = waterResources.waveDataBuffer;
    const modifiersBuffer = waterResources.modifiersBuffer;

    const needsRebuild =
      !this.terrainScreenBindGroup ||
      !this.waterHeightBindGroup ||
      !this.compositeBindGroup ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
      this.lastModifiersBuffer !== modifiersBuffer ||
      this.lastTerrainAtlasView !== terrainAtlasView ||
      this.lastWaveFieldTextureView !== this.waveFieldTextureView;

    if (!needsRebuild) return;

    // Terrain screen bind group (samples atlas → screen-space texture)
    if (
      this.terrainScreenShader &&
      this.terrainScreenUniformBuffer &&
      this.terrainHeightView
    ) {
      this.terrainScreenBindGroup = this.terrainScreenShader.createBindGroup({
        params: { buffer: this.terrainScreenUniformBuffer },
        terrainTileAtlas: terrainAtlasView,
        outputTexture: this.terrainHeightView,
      });
    }

    // Water height bind group (uses wave field texture instead of shadow/terrain)
    if (
      this.waterHeightShader &&
      this.waterHeightUniformBuffer &&
      this.waterHeightView &&
      this.waveFieldTextureView &&
      this.waveFieldSampler
    ) {
      this.waterHeightBindGroup = this.waterHeightShader.createBindGroup({
        params: { buffer: this.waterHeightUniformBuffer },
        waveData: { buffer: waveDataBuffer },
        modifiers: { buffer: modifiersBuffer },
        waveFieldTexture: this.waveFieldTextureView,
        waveFieldSampler: this.waveFieldSampler,
        outputTexture: this.waterHeightView,
      });
    }

    // Composite bind group (uses terrain tile atlas and wetness texture)
    const wetnessTextureView = this.wetnessPipeline?.getOutputTextureView();
    if (
      this.compositeShader &&
      this.compositeUniformBuffer &&
      this.waterHeightView &&
      this.heightSampler &&
      wetnessTextureView
    ) {
      this.compositeBindGroup = this.compositeShader.createBindGroup({
        params: { buffer: this.compositeUniformBuffer },
        waterHeightTexture: this.waterHeightView,
        terrainTileAtlas: terrainAtlasView,
        wetnessTexture: wetnessTextureView,
        heightSampler: this.heightSampler,
      });
    }

    // Update tracking
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastModifiersBuffer = modifiersBuffer;
    this.lastTerrainAtlasView = terrainAtlasView;
    this.lastWaveFieldTextureView = this.waveFieldTextureView;
  }

  @on("render")
  onRender(event: { dt: number; draw: Draw }) {
    if (!this.initialized || !this.terrainTileCache) return;

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

    // Get resources (these are required - will throw if missing)
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const waterResources = this.game.entities.getSingleton(WaterResources);
    const terrainResources = this.game.entities.getSingleton(TerrainResources);

    // Ensure intermediate textures
    this.ensureTextures(width, height);

    // Get camera matrix
    const cameraMatrix = camera.getMatrix().clone().invert();

    // === Terrain Tile Cache Update ===
    // Check for terrain changes and invalidate if needed
    this.terrainTileCache.checkInvalidation(terrainResources);

    // Update tile cache and get tiles that need rendering
    // Pass camera.z (zoom level) for LOD selection
    const tileRequests = this.terrainTileCache.update(
      expandedViewport,
      camera.z,
      terrainResources,
    );

    // Render any missing tiles
    if (tileRequests.length > 0) {
      this.terrainTileCache.renderTiles(
        tileRequests,
        terrainResources,
        gpuProfiler ?? undefined,
      );
    }

    // Get terrain atlas view for composite shader
    const terrainAtlasView = this.terrainTileCache.getAtlasView();

    // Update all uniforms
    this.updateTerrainScreenUniforms(expandedViewport, width, height);
    this.updateWaterHeightUniforms(
      expandedViewport,
      currentTime,
      width,
      height,
      waterResources,
    );
    // Get the camera viewport (non-expanded) for correct clip-to-world mapping
    const cameraViewport = camera.getWorldViewport();
    this.updateCompositeUniforms(
      expandedViewport,
      cameraViewport,
      currentTime,
      width,
      height,
      cameraMatrix,
      waterResources,
      terrainResources,
    );

    // Upload uniforms
    this.terrainScreenUniforms?.uploadTo(this.terrainScreenUniformBuffer!);
    this.waterHeightUniforms?.uploadTo(this.waterHeightUniformBuffer!);
    this.compositeUniforms?.uploadTo(this.compositeUniformBuffer!);

    // Ensure bind groups
    this.ensureBindGroups(waterResources, terrainAtlasView);

    // === Pass 1: Terrain Screen Compute ===
    // Sample terrain atlas to screen-space texture for water height shader
    if (this.terrainScreenShader && this.terrainScreenBindGroup) {
      const commandEncoder = device.createCommandEncoder({
        label: "Terrain Screen Compute",
      });
      const computePass = commandEncoder.beginComputePass({
        label: "Terrain Screen Compute Pass",
        timestampWrites:
          gpuProfiler?.getComputeTimestampWrites("surface.terrain"),
      });
      this.terrainScreenShader.dispatch(
        computePass,
        this.terrainScreenBindGroup,
        width,
        height,
      );
      computePass.end();
      device.queue.submit([commandEncoder.finish()]);
    }

    // === Pass 1.5: Wave Field Rasterization ===
    // Rasterize wavefront meshes to screen-space texture array
    if (this.waveFieldTexture && wavePhysicsResources) {
      const rasterizer = wavePhysicsResources.getRasterizer();
      const activeMeshes = wavePhysicsResources.getActiveMeshes();
      const commandEncoder = device.createCommandEncoder({
        label: "Wave Field Rasterization",
      });
      rasterizer.render(
        commandEncoder,
        activeMeshes,
        expandedViewport,
        this.waveFieldTexture,
        gpuProfiler,
      );
      device.queue.submit([commandEncoder.finish()]);
    }

    // === Pass 2: Water Height Compute ===
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

    // === Wetness Update Pass ===
    if (
      this.wetnessPipeline &&
      this.wetnessPipeline.isInitialized() &&
      this.waterHeightView &&
      this.terrainHeightView
    ) {
      // Use same viewport for wetness as for rendering
      this.wetnessPipeline.update(
        expandedViewport,
        expandedViewport,
        this.waterHeightView,
        this.terrainHeightView,
        event.dt,
        gpuProfiler,
      );
    }

    // === Pass 3: Surface Composite (fragment) ===
    const renderPass = renderer.getCurrentRenderPass();
    if (renderPass && this.compositeShader && this.compositeBindGroup) {
      this.compositeShader.render(renderPass, this.compositeBindGroup);
    }
  }

  /**
   * Get the screen-space terrain height texture (output of Pass 1).
   * Returns null if not initialized.
   */
  getTerrainHeightTextureView(): GPUTextureView | null {
    return this.terrainHeightView;
  }

  /**
   * Get the terrain tile atlas view for debug visualization.
   * Returns null if not initialized.
   */
  getTerrainAtlasView(): GPUTextureView | null {
    return this.terrainTileCache?.getAtlasView() ?? null;
  }

  /**
   * Get terrain tile cache stats for debugging.
   */
  getTerrainTileCacheStats(): {
    cachedTiles: number;
    readyTiles: number;
    currentLOD: number;
    worldUnitsPerTile: number;
  } | null {
    if (!this.terrainTileCache) return null;
    const lodConfig = this.terrainTileCache.getCurrentLODConfig();
    return {
      cachedTiles: this.terrainTileCache.getCachedTileCount(),
      readyTiles: this.terrainTileCache.getReadyTileCount(),
      currentLOD: this.terrainTileCache.getCurrentLOD(),
      worldUnitsPerTile: lodConfig.worldUnitsPerTile,
    };
  }

  @on("destroy")
  onDestroy(): void {
    this.terrainScreenShader?.destroy();
    this.waterHeightShader?.destroy();
    this.compositeShader?.destroy();
    this.terrainTileCache?.destroy();
    this.wetnessPipeline?.destroy();
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture?.destroy();
    this.terrainScreenUniformBuffer?.destroy();
    this.waterHeightUniformBuffer?.destroy();
    this.compositeUniformBuffer?.destroy();
  }
}
