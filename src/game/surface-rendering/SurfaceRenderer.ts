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
import { createWaterHeightShader } from "./WaterHeightShader";
import { createSurfaceCompositeShader } from "./SurfaceCompositeShader";
import { WaterHeightUniforms } from "./WaterHeightUniforms";
import { SurfaceCompositeUniforms } from "./SurfaceCompositeUniforms";
import { LODTerrainTileCache } from "./LODTerrainTileCache";

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
  private compositeShader: FullscreenShader | null = null;

  // LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
  private terrainTileCache: LODTerrainTileCache | null = null;

  // Intermediate textures
  private waterHeightTexture: GPUTexture | null = null;
  private waterHeightView: GPUTextureView | null = null;

  // Uniform buffers
  private waterHeightUniformBuffer: GPUBuffer | null = null;
  private compositeUniformBuffer: GPUBuffer | null = null;

  // Uniform instances
  private waterHeightUniforms: UniformInstance<
    typeof WaterHeightUniforms.fields
  > | null = null;
  private compositeUniforms: UniformInstance<
    typeof SurfaceCompositeUniforms.fields
  > | null = null;

  // Samplers
  private heightSampler: GPUSampler | null = null;

  // Bind groups (recreated when resources change)
  private waterHeightBindGroup: GPUBindGroup | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;

  // Track last resources
  private lastTextureWidth = 0;
  private lastTextureHeight = 0;
  private lastShadowDataBuffer: GPUBuffer | null = null;
  private lastShadowVerticesBuffer: GPUBuffer | null = null;
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastModifiersBuffer: GPUBuffer | null = null;
  private lastTerrainAtlasView: GPUTextureView | null = null;

  // Placeholder shadow buffers (for when wave physics isn't ready)
  private placeholderShadowDataBuffer: GPUBuffer | null = null;
  private placeholderShadowVerticesBuffer: GPUBuffer | null = null;

  constructor() {
    super();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;

      // Create shaders
      this.waterHeightShader = createWaterHeightShader();
      this.compositeShader = createSurfaceCompositeShader();

      // Create LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
      // Supports zoom range 0.02 to 1.0+ by using progressively larger world units per tile
      this.terrainTileCache = new LODTerrainTileCache();

      await Promise.all([
        this.waterHeightShader.init(),
        this.compositeShader.init(),
        this.terrainTileCache.init(),
      ]);

      // Create uniform buffers
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

      // Create placeholder shadow data buffer (empty - no polygons)
      // Layout: waveDirection (vec2), polygonCount (u32), viewport (4 f32), padding (f32)
      // = 32 bytes header with polygonCount = 0
      this.placeholderShadowDataBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: "Placeholder Shadow Data Buffer",
      });
      // Initialize with zero polygon count
      const placeholderData = new Float32Array([
        1.0,
        0.0, // waveDirection
        0, // polygonCount (as float, will be reinterpreted)
        0,
        0,
        0,
        0, // viewport
        0, // padding
      ]);
      const placeholderUint = new Uint32Array(placeholderData.buffer);
      placeholderUint[2] = 0; // Set polygonCount to 0
      device.queue.writeBuffer(
        this.placeholderShadowDataBuffer,
        0,
        placeholderData,
      );

      // Create placeholder shadow vertices buffer (empty - just needs to exist)
      this.placeholderShadowVerticesBuffer = device.createBuffer({
        size: 8, // Minimum size: one vec2<f32>
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: "Placeholder Shadow Vertices Buffer",
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

    // Create water height texture
    this.waterHeightTexture = device.createTexture({
      size: { width, height },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Water Height Texture",
    });
    this.waterHeightView = this.waterHeightTexture.createView();

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    // Force bind group recreation
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
    this.waterHeightUniforms.set.waveSourceDirection(
      waterResources.getAnalyticalConfig().waveSourceDirection,
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
    waterResources: WaterResources,
    terrainResources: TerrainResources,
  ): void {
    if (!this.compositeUniforms || !this.terrainTileCache) return;

    this.compositeUniforms.set.cameraMatrix(cameraMatrix);
    this.compositeUniforms.set.screenWidth(width);
    this.compositeUniforms.set.screenHeight(height);
    this.compositeUniforms.set.viewportLeft(viewport.left);
    this.compositeUniforms.set.viewportTop(viewport.top);
    this.compositeUniforms.set.viewportWidth(viewport.width);
    this.compositeUniforms.set.viewportHeight(viewport.height);
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
  }

  /**
   * Ensure bind groups are up to date.
   */
  private ensureBindGroups(
    waterResources: WaterResources,
    shadowDataBuffer: GPUBuffer,
    shadowVerticesBuffer: GPUBuffer,
    terrainAtlasView: GPUTextureView,
  ): void {
    const waveDataBuffer = waterResources.waveDataBuffer;
    const modifiersBuffer = waterResources.modifiersBuffer;

    const needsRebuild =
      !this.waterHeightBindGroup ||
      !this.compositeBindGroup ||
      this.lastShadowDataBuffer !== shadowDataBuffer ||
      this.lastShadowVerticesBuffer !== shadowVerticesBuffer ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
      this.lastModifiersBuffer !== modifiersBuffer ||
      this.lastTerrainAtlasView !== terrainAtlasView;

    if (!needsRebuild) return;

    // Water height bind group (includes shadow data for analytical attenuation)
    if (
      this.waterHeightShader &&
      this.waterHeightUniformBuffer &&
      this.waterHeightView
    ) {
      this.waterHeightBindGroup = this.waterHeightShader.createBindGroup({
        params: { buffer: this.waterHeightUniformBuffer },
        waveData: { buffer: waveDataBuffer },
        modifiers: { buffer: modifiersBuffer },
        shadowData: { buffer: shadowDataBuffer },
        shadowVertices: { buffer: shadowVerticesBuffer },
        outputTexture: this.waterHeightView,
      });
    }

    // Composite bind group (uses terrain tile atlas)
    if (
      this.compositeShader &&
      this.compositeUniformBuffer &&
      this.waterHeightView &&
      this.heightSampler
    ) {
      this.compositeBindGroup = this.compositeShader.createBindGroup({
        params: { buffer: this.compositeUniformBuffer },
        waterHeightTexture: this.waterHeightView,
        terrainTileAtlas: terrainAtlasView,
        heightSampler: this.heightSampler,
      });
    }

    // Update tracking
    this.lastShadowDataBuffer = shadowDataBuffer;
    this.lastShadowVerticesBuffer = shadowVerticesBuffer;
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastModifiersBuffer = modifiersBuffer;
    this.lastTerrainAtlasView = terrainAtlasView;
  }

  @on("render")
  onRender(_event: { dt: number; draw: Draw }) {
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

    // Get shadow buffers for analytical wave attenuation
    const shadowDataBuffer =
      wavePhysicsResources?.getShadowDataBuffer() ??
      this.placeholderShadowDataBuffer!;
    const shadowVerticesBuffer =
      wavePhysicsResources?.getShadowVerticesBuffer() ??
      this.placeholderShadowVerticesBuffer!;

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
    this.updateWaterHeightUniforms(
      expandedViewport,
      currentTime,
      width,
      height,
      waterResources,
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
    this.compositeUniforms?.uploadTo(this.compositeUniformBuffer!);

    // Ensure bind groups
    this.ensureBindGroups(
      waterResources,
      shadowDataBuffer,
      shadowVerticesBuffer,
      terrainAtlasView,
    );

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

    // === Pass 3: Surface Composite ===
    const renderPass = renderer.getCurrentRenderPass();
    if (renderPass && this.compositeShader && this.compositeBindGroup) {
      this.compositeShader.render(renderPass, this.compositeBindGroup);
    }
  }

  /**
   * Get the terrain tile atlas view for debug visualization.
   * Returns null if not initialized.
   */
  getTerrainHeightTextureView(): GPUTextureView | null {
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
    this.waterHeightShader?.destroy();
    this.compositeShader?.destroy();
    this.terrainTileCache?.destroy();
    this.waterHeightTexture?.destroy();
    this.waterHeightUniformBuffer?.destroy();
    this.compositeUniformBuffer?.destroy();
    this.placeholderShadowDataBuffer?.destroy();
    this.placeholderShadowVerticesBuffer?.destroy();
  }
}
