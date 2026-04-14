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
import { Matrix3 } from "../../core/graphics/Matrix3";
import { type UniformInstance } from "../../core/graphics/UniformStruct";
import type { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import type { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { MAX_WAVE_SOURCES } from "../wave-physics/WavePhysicsManager";
import { TimeOfDay } from "../time/TimeOfDay";
import {
  WavePhysicsResources,
  type Viewport,
} from "../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WaterResources } from "../world/water/WaterResources";
import { ModifierRasterizer } from "./ModifierRasterizer";
import { createWaterHeightShader } from "./WaterHeightShader";
import { createTerrainCompositeShader } from "./TerrainCompositeShader";
import { createWaterFilterShader } from "./WaterFilterShader";
import { createTerrainScreenShader } from "./TerrainScreenShader";
import { WaterHeightUniforms } from "./WaterHeightUniforms";
import { TerrainCompositeUniforms } from "./TerrainCompositeUniforms";
import { WaterFilterUniforms } from "./WaterFilterUniforms";
import { TerrainScreenUniforms } from "./TerrainScreenUniforms";
import { LODTerrainTileCache } from "./LODTerrainTileCache";
import { WetnessRenderPipeline } from "./WetnessRenderPipeline";
import {
  type BiomeConfig,
  DEFAULT_BIOME_CONFIG,
  BIOME_BUFFER_SIZE,
  packBiomeBuffer,
} from "./BiomeConfig";

// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

// Modifier texture resolution scale (fraction of screen resolution)
const MODIFIER_RESOLUTION_SCALE = 0.25;

/**
 * Surface renderer entity using multi-pass rendering.
 */
export class SurfaceRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "surface" as const;

  private initialized = false;
  private enabled = false;

  // Shaders for each pass
  private terrainScreenShader: ComputeShader | null = null;
  private waterHeightShader: ComputeShader | null = null;
  private terrainCompositeShader: FullscreenShader | null = null;
  private waterFilterShader: FullscreenShader | null = null;

  // LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
  private terrainTileCache: LODTerrainTileCache | null = null;

  // Wetness render pipeline (tracks sand wetness over time)
  private wetnessPipeline: WetnessRenderPipeline | null = null;

  // Modifier rasterizer (wakes, ripples → screen-space texture)
  private modifierRasterizer: ModifierRasterizer | null = null;
  private modifierTexture: GPUTexture | null = null;
  private modifierTextureView: GPUTextureView | null = null;
  private modifierSampler: GPUSampler | null = null;

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
  private terrainCompositeUniformBuffer: GPUBuffer | null = null;
  private waterFilterUniformBuffer: GPUBuffer | null = null;
  private biomeUniformBuffer: GPUBuffer | null = null;

  // Uniform instances
  private terrainScreenUniforms: UniformInstance<
    typeof TerrainScreenUniforms.fields
  > | null = null;
  private waterHeightUniforms: UniformInstance<
    typeof WaterHeightUniforms.fields
  > | null = null;
  private terrainCompositeUniforms: UniformInstance<
    typeof TerrainCompositeUniforms.fields
  > | null = null;
  private waterFilterUniforms: UniformInstance<
    typeof WaterFilterUniforms.fields
  > | null = null;

  // Samplers
  private heightSampler: GPUSampler | null = null;

  // Bind groups (recreated when resources change)
  private terrainScreenBindGroup: GPUBindGroup | null = null;
  private waterHeightBindGroup: GPUBindGroup | null = null;
  private terrainCompositeBindGroup: GPUBindGroup | null = null;
  private waterFilterBindGroup: GPUBindGroup | null = null;

  // Track last resources
  private lastTextureWidth = 0;
  private lastTextureHeight = 0;
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastTerrainAtlasView: GPUTextureView | null = null;
  private lastWaveFieldTextureView: GPUTextureView | null = null;

  private biomeConfig: BiomeConfig;

  constructor(biomeConfig?: BiomeConfig) {
    super();
    this.biomeConfig = biomeConfig ?? DEFAULT_BIOME_CONFIG;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = this.game.getWebGPUDevice();

      // Create shaders
      this.terrainScreenShader = createTerrainScreenShader();
      this.waterHeightShader = createWaterHeightShader();
      this.terrainCompositeShader = createTerrainCompositeShader();
      this.waterFilterShader = createWaterFilterShader();

      // Create LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
      // Supports zoom range 0.02 to 1.0+ by using progressively larger world units per tile
      this.terrainTileCache = new LODTerrainTileCache(device);

      // Create wetness render pipeline (will be sized when textures are created)
      // Using placeholder size - will be recreated when ensureTextures is called
      this.wetnessPipeline = new WetnessRenderPipeline(device, 1, 1);

      // Create modifier rasterizer
      this.modifierRasterizer = new ModifierRasterizer(device);

      await Promise.all([
        this.terrainScreenShader.init(),
        this.waterHeightShader.init(),
        this.terrainCompositeShader.init(),
        this.waterFilterShader.init(),
        this.terrainTileCache.init(),
        this.wetnessPipeline.init(),
        this.modifierRasterizer.init(),
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
      this.terrainCompositeUniformBuffer = device.createBuffer({
        size: TerrainCompositeUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Terrain Composite Uniform Buffer",
      });
      this.waterFilterUniformBuffer = device.createBuffer({
        size: WaterFilterUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Water Filter Uniform Buffer",
      });

      // Biome uniform buffer — uploaded once per level load
      this.biomeUniformBuffer = device.createBuffer({
        size: BIOME_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Biome Uniform Buffer",
      });
      const biomeData = packBiomeBuffer(this.biomeConfig);
      device.queue.writeBuffer(this.biomeUniformBuffer, 0, biomeData.buffer);

      // Create uniform instances
      this.terrainScreenUniforms = TerrainScreenUniforms.create();
      this.waterHeightUniforms = WaterHeightUniforms.create();
      this.terrainCompositeUniforms = TerrainCompositeUniforms.create();
      this.waterFilterUniforms = WaterFilterUniforms.create();

      this.terrainCompositeUniforms.set.hasTerrainData(0);
      this.waterFilterUniforms.set.hasTerrainData(0);

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

      // Create modifier sampler (linear filtering, clamp-to-edge)
      this.modifierSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        label: "Modifier Sampler",
      });

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize SurfaceRenderer:", error);
    }
  }

  private initPromise: Promise<void> | null = null;

  @on("add")
  onAdd() {
    this.initPromise = this.ensureInitialized();
  }

  /**
   * Returns a promise that resolves when shader compilation is complete.
   */
  whenReady(): Promise<void> {
    return this.initPromise ?? Promise.resolve();
  }

  /**
   * Allow rendering to begin. Called by GameController once all systems are ready.
   */
  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /**
   * Ensure intermediate textures exist and match screen size.
   */
  private ensureTextures(width: number, height: number): void {
    if (this.lastTextureWidth === width && this.lastTextureHeight === height) {
      return;
    }

    const device = this.game.getWebGPUDevice();

    // Destroy old textures
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture?.destroy();
    this.modifierTexture?.destroy();

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

    // Create modifier texture at reduced resolution (wakes are low-frequency)
    const modW = Math.max(1, Math.round(width * MODIFIER_RESOLUTION_SCALE));
    const modH = Math.max(1, Math.round(height * MODIFIER_RESOLUTION_SCALE));
    this.modifierTexture = device.createTexture({
      size: { width: modW, height: modH },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Modifier Texture",
    });
    this.modifierTextureView = this.modifierTexture.createView({
      label: "Modifier Texture View",
    });

    // Recreate wetness pipeline with new texture size
    this.wetnessPipeline = new WetnessRenderPipeline(device, width, height);
    this.wetnessPipeline.init();

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    // Force bind group recreation
    this.terrainScreenBindGroup = null;
    this.waterHeightBindGroup = null;
    this.terrainCompositeBindGroup = null;
    this.waterFilterBindGroup = null;
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
    this.waterHeightUniforms.set.numWaves(waterResources.getNumWaves());
  }

  /**
   * Update uniforms for terrain composite pass.
   */
  private updateTerrainCompositeUniforms(
    expandedViewport: Viewport,
    currentTime: number,
    width: number,
    height: number,
    clipToWorldMatrix: Matrix3,
    waterResources: WaterResources,
    terrainResources: TerrainResources,
  ): void {
    if (!this.terrainCompositeUniforms || !this.terrainTileCache) return;

    this.terrainCompositeUniforms.set.cameraMatrix(clipToWorldMatrix);
    this.terrainCompositeUniforms.set.screenWidth(width);
    this.terrainCompositeUniforms.set.screenHeight(height);
    this.terrainCompositeUniforms.set.viewportLeft(expandedViewport.left);
    this.terrainCompositeUniforms.set.viewportTop(expandedViewport.top);
    this.terrainCompositeUniforms.set.viewportWidth(expandedViewport.width);
    this.terrainCompositeUniforms.set.viewportHeight(expandedViewport.height);
    this.terrainCompositeUniforms.set.time(currentTime);
    this.terrainCompositeUniforms.set.tideHeight(
      waterResources.getTideHeight(),
    );
    this.terrainCompositeUniforms.set.hasTerrainData(terrainResources ? 1 : 0);

    const atlasInfo = this.terrainTileCache.getAtlasInfo();
    this.terrainCompositeUniforms.set.atlasTileSize(atlasInfo.tileSize);
    this.terrainCompositeUniforms.set.atlasTilesX(atlasInfo.tilesX);
    this.terrainCompositeUniforms.set.atlasTilesY(atlasInfo.tilesY);
    this.terrainCompositeUniforms.set.atlasWorldUnitsPerTile(
      atlasInfo.worldUnitsPerTile,
    );
  }

  /**
   * Update uniforms for water filter pass.
   */
  private updateWaterFilterUniforms(
    expandedViewport: Viewport,
    currentTime: number,
    width: number,
    height: number,
    clipToWorldMatrix: Matrix3,
    waterResources: WaterResources,
    terrainResources: TerrainResources,
  ): void {
    if (!this.waterFilterUniforms) return;

    this.waterFilterUniforms.set.cameraMatrix(clipToWorldMatrix);
    this.waterFilterUniforms.set.screenWidth(width);
    this.waterFilterUniforms.set.screenHeight(height);
    this.waterFilterUniforms.set.viewportLeft(expandedViewport.left);
    this.waterFilterUniforms.set.viewportTop(expandedViewport.top);
    this.waterFilterUniforms.set.viewportWidth(expandedViewport.width);
    this.waterFilterUniforms.set.viewportHeight(expandedViewport.height);
    this.waterFilterUniforms.set.time(currentTime);
    this.waterFilterUniforms.set.tideHeight(waterResources.getTideHeight());
    this.waterFilterUniforms.set.hasTerrainData(terrainResources ? 1 : 0);
  }

  /**
   * Ensure bind groups are up to date.
   */
  private ensureBindGroups(
    waterResources: WaterResources,
    terrainAtlasView: GPUTextureView,
  ): void {
    const waveDataBuffer = waterResources.waveDataBuffer;

    const needsRebuild =
      !this.terrainScreenBindGroup ||
      !this.waterHeightBindGroup ||
      !this.terrainCompositeBindGroup ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
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

    // Water height bind group (uses wave field + modifier textures)
    if (
      this.waterHeightShader &&
      this.waterHeightUniformBuffer &&
      this.waterHeightView &&
      this.waveFieldTextureView &&
      this.waveFieldSampler &&
      this.modifierTextureView &&
      this.modifierSampler
    ) {
      this.waterHeightBindGroup = this.waterHeightShader.createBindGroup({
        params: { buffer: this.waterHeightUniformBuffer },
        waveData: { buffer: waveDataBuffer },
        modifierTexture: this.modifierTextureView,
        modifierSampler: this.modifierSampler,
        waveFieldTexture: this.waveFieldTextureView,
        waveFieldSampler: this.waveFieldSampler,
        outputTexture: this.waterHeightView,
      });
    }

    // Terrain composite bind group (stable — reads only compute outputs)
    const wetnessTextureView = this.wetnessPipeline?.getOutputTextureView();
    if (
      this.terrainCompositeShader &&
      this.terrainCompositeUniformBuffer &&
      this.biomeUniformBuffer &&
      this.waterHeightView &&
      this.heightSampler &&
      wetnessTextureView
    ) {
      this.terrainCompositeBindGroup =
        this.terrainCompositeShader.createBindGroup({
          params: { buffer: this.terrainCompositeUniformBuffer },
          waterHeightTexture: this.waterHeightView,
          terrainTileAtlas: terrainAtlasView,
          wetnessTexture: wetnessTextureView,
          heightSampler: this.heightSampler,
          biomeParams: { buffer: this.biomeUniformBuffer },
        });
    }

    // Note: water filter bind group is rebuilt separately in
    // rebuildWaterFilterBindGroup() right before the filter pass, after
    // depth and color copies produce their readable views.

    // Update tracking
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastTerrainAtlasView = terrainAtlasView;
    this.lastWaveFieldTextureView = this.waveFieldTextureView;
  }

  /**
   * Rebuild the water filter bind group with current scene color and depth
   * copy views. Called right before the water filter pass.
   */
  private rebuildWaterFilterBindGroup(
    sceneColorView: GPUTextureView | null,
    sceneDepthView: GPUTextureView | null,
  ): void {
    if (
      this.waterFilterShader &&
      this.waterFilterUniformBuffer &&
      this.waterHeightView &&
      this.heightSampler &&
      sceneColorView &&
      sceneDepthView
    ) {
      this.waterFilterBindGroup = this.waterFilterShader.createBindGroup({
        params: { buffer: this.waterFilterUniformBuffer },
        sceneColorTexture: sceneColorView,
        sceneDepthTexture: sceneDepthView,
        waterHeightTexture: this.waterHeightView,
        heightSampler: this.heightSampler,
      });
    }
  }

  @on("render")
  onRender(event: { dt: number; draw: Draw }) {
    if (!this.initialized || !this.terrainTileCache || !this.enabled) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const gpuProfiler = renderer.getGpuProfiler();
    const device = this.game.getWebGPUDevice();

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

    // Compute clip-to-world matrix: maps clip space (-1,1) directly to world space.
    // Composed as: screenToWorld * clipToScreen
    // Note: clipToScreen does NOT flip Y here. The old UV-based clipToWorld used
    // uvY = -clipY*0.5+0.5, which combined with the viewport bounds produced a
    // mapping equivalent to clip(-1,-1)→screen(0,0). The camera inverse already
    // handles the world Y-up ↔ screen Y-down conversion.
    const clipToScreen = new Matrix3();
    clipToScreen.translate(width / 2, height / 2);
    clipToScreen.scale(width / 2, height / 2);
    const clipToWorldMatrix = camera.getMatrix().clone().invert();
    clipToWorldMatrix.multiply(clipToScreen);

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

    // Render any missing tiles (current LOD + budget-limited adjacent pre-warming)
    this.terrainTileCache.renderTiles(
      tileRequests,
      terrainResources,
      gpuProfiler ?? undefined,
    );

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
    this.updateTerrainCompositeUniforms(
      expandedViewport,
      currentTime,
      width,
      height,
      clipToWorldMatrix,
      waterResources,
      terrainResources,
    );
    this.updateWaterFilterUniforms(
      expandedViewport,
      currentTime,
      width,
      height,
      clipToWorldMatrix,
      waterResources,
      terrainResources,
    );

    // Upload uniforms
    this.terrainScreenUniforms?.uploadTo(this.terrainScreenUniformBuffer!);
    this.waterHeightUniforms?.uploadTo(this.waterHeightUniformBuffer!);
    this.terrainCompositeUniforms?.uploadTo(
      this.terrainCompositeUniformBuffer!,
    );
    this.waterFilterUniforms?.uploadTo(this.waterFilterUniformBuffer!);

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
      if (rasterizer) {
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
    }

    // === Pass 1.75: Modifier Rasterization ===
    // Rasterize wake/ripple contributions to screen-space texture
    if (this.modifierRasterizer && this.modifierTexture) {
      const commandEncoder = device.createCommandEncoder({
        label: "Modifier Rasterization",
      });
      this.modifierRasterizer.render(
        commandEncoder,
        waterResources.modifiersBuffer,
        waterResources.getModifierCount(),
        expandedViewport,
        this.modifierTexture,
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

    const webgpuRenderer = this.game.getRenderer();

    // === Pass 3a: Terrain Composite (fragment) ===
    // Renders above-water terrain into the current mainColorTexture pass.
    // greater-equal depth test: boat pixels already at higher z block terrain.
    // Pixels where waterDepth >= 0 are discarded — water filter handles those.
    const terrainPass = renderer.getCurrentRenderPass();
    if (
      terrainPass &&
      this.terrainCompositeShader &&
      this.terrainCompositeBindGroup
    ) {
      this.terrainCompositeShader.render(
        terrainPass,
        this.terrainCompositeBindGroup,
      );
    }

    // Copy depth and color so the water filter can read the frozen scene.
    // Ordering: terrain composite → copyDepthBuffer → copyColorBuffer.
    // copyColorBuffer switches the active render target from mainColorTexture
    // to the swapchain; subsequent draw calls go to the final frame output.
    webgpuRenderer.copyDepthBuffer();
    webgpuRenderer.copyColorBuffer();

    const sceneColorView = webgpuRenderer.getColorCopyTextureView();
    const sceneDepthView = webgpuRenderer.getDepthCopyTextureView();
    this.rebuildWaterFilterBindGroup(sceneColorView, sceneDepthView);

    // === Pass 3b: Water Filter (fragment) ===
    // Applies physically-based absorption to the frozen scene and writes
    // the final composited pixel to the swapchain. Post-water particles
    // (wake, foam, spray) render on top in their own layers afterward.
    const filterPass = renderer.getCurrentRenderPass();
    if (filterPass && this.waterFilterShader && this.waterFilterBindGroup) {
      this.waterFilterShader.render(filterPass, this.waterFilterBindGroup);
    }
  }

  /**
   * Get the screen-space water height texture (output of Pass 2).
   * Returns null if not initialized.
   */
  getWaterHeightTextureView(): GPUTextureView | null {
    return this.waterHeightView;
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
    this.terrainCompositeShader?.destroy();
    this.waterFilterShader?.destroy();
    this.terrainTileCache?.destroy();
    this.wetnessPipeline?.destroy();
    this.modifierRasterizer?.destroy();
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture?.destroy();
    this.modifierTexture?.destroy();
    this.terrainScreenUniformBuffer?.destroy();
    this.waterHeightUniformBuffer?.destroy();
    this.terrainCompositeUniformBuffer?.destroy();
    this.waterFilterUniformBuffer?.destroy();
    this.biomeUniformBuffer?.destroy();
  }
}
