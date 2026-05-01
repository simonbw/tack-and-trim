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
import { profiler } from "../../core/util/Profiler";
import type { Boat } from "../boat/Boat";
import { pushSceneLighting } from "../time/SceneLighting";
import { TimeOfDay } from "../time/TimeOfDay";
import { WeatherState } from "../weather/WeatherState";
import { MAX_WAVE_SOURCES } from "../wave-physics/WavePhysicsManager";
import {
  WavePhysicsResources,
  type Viewport,
} from "../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WaterResources } from "../world/water/WaterResources";
import { WindResources } from "../world/wind/WindResources";
import {
  BIOME_BUFFER_SIZE,
  DEFAULT_BIOME_CONFIG,
  packBiomeBuffer,
  type BiomeConfig,
} from "./BiomeConfig";
import { BoatAirShader } from "./BoatAirShader";
import { LODTerrainTileCache } from "./LODTerrainTileCache";
import { ModifierRasterizer } from "./ModifierRasterizer";
import {
  createTerrainCompositeShader,
  TerrainCompositeUniforms,
} from "./TerrainCompositeShader";
import {
  createTerrainScreenShader,
  TerrainScreenUniforms,
} from "./TerrainScreenShader";
import {
  createWaterFilterShader,
  WaterFilterUniforms,
} from "./WaterFilterShader";
import {
  createWaterHeightShader,
  WaterHeightUniforms,
} from "./WaterHeightShader";
import { createWindFieldShader, WindFieldUniforms } from "./WindFieldShader";
import { pushWaterTuning } from "./WaterTuning";
import { SURFACE_TEXTURE_MARGIN } from "./SurfaceConstants";
import {
  getWaterQualityScale,
  onWaterQualityChange,
} from "./WaterQualityState";
import {
  getRenderScaleFactor,
  onRenderScaleChange,
} from "../../core/graphics/RenderScaleState";
import { WetnessRenderPipeline } from "./WetnessRenderPipeline";

// World viewport margin for the terrain tile cache. Independent of the
// texture-pixel margin — this drives which tiles the cache keeps hot.
const TILE_CACHE_VIEWPORT_MARGIN = 0.1;

// Modifier texture resolution scale (fraction of surface texture resolution)
const MODIFIER_RESOLUTION_SCALE = 1.0 / 2.0;

// Water-height texture resolution scale comes from the user-facing
// WaterQualityState (low=0.25 / medium=0.5 / high=1.0). The water filter
// samples the height texture with linear filtering via worldToTexClip, so
// reducing the resolution costs some normal/height detail but the analytic
// gradient stored in the BA channels stays smooth under bilinear interp —
// no finite-diff facets even at low quality.

// Default bio-optical water chemistry. These drive the water filter's
// absorption/scattering computation. Eventually they should come from the
// level's BiomeConfig / region file; for now they're clean-coastal defaults.
//   chlorophyll: mg/m³     — 0.01 open ocean, 1 coastal, 10 bloom
//   cdom:        normalized — 0 clean, 1 typical coastal, 2+ tannic
//   sediment:    normalized — 0 clean, 1 typical coastal, 3 turbid
const DEFAULT_CHLOROPHYLL = 0.5;
const DEFAULT_CDOM = 0.3;
const DEFAULT_SEDIMENT = 0.4;

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
  private windFieldShader: ComputeShader | null = null;
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
  // Per-boat air gap (bilge surface Z + deck cap Z + bilge turbulence).
  // Read by the water height compute as a substitution input — see
  // BoatAirShader and WaterHeightShader.
  private boatAirTexture: GPUTexture | null = null;
  private boatAirTextureView: GPUTextureView | null = null;

  // Wave field texture array (rgba16float, one layer per wave source)
  private waveFieldTexture: GPUTexture | null = null;
  private waveFieldTextureView: GPUTextureView | null = null;
  private waveFieldSampler: GPUSampler | null = null;

  // Wind field texture (rgba16float, half-res of surface texture).
  // Encoding: (velX, velY, speed, 0) in ft/s.
  private windFieldTexture: GPUTexture | null = null;
  private windFieldTextureView: GPUTextureView | null = null;
  private windFieldSampler: GPUSampler | null = null;

  // Uniform buffers
  private terrainScreenUniformBuffer: GPUBuffer | null = null;
  private waterHeightUniformBuffer: GPUBuffer | null = null;
  private windFieldUniformBuffer: GPUBuffer | null = null;
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
  private windFieldUniforms: UniformInstance<
    typeof WindFieldUniforms.fields
  > | null = null;
  private terrainCompositeUniforms: UniformInstance<
    typeof TerrainCompositeUniforms.fields
  > | null = null;
  private waterFilterUniforms: UniformInstance<
    typeof WaterFilterUniforms.fields
  > | null = null;

  // Boat air rasterizer — feeds boatAirTexture to the water height compute.
  private boatAirShader: BoatAirShader | null = null;

  // Samplers
  private heightSampler: GPUSampler | null = null;

  // Bind groups (recreated when resources change)
  private terrainScreenBindGroup: GPUBindGroup | null = null;
  private waterHeightBindGroup: GPUBindGroup | null = null;
  private windFieldBindGroup: GPUBindGroup | null = null;
  private lastWindMeshBuffer: GPUBuffer | null = null;
  private terrainCompositeBindGroup: GPUBindGroup | null = null;
  private waterFilterBindGroup: GPUBindGroup | null = null;

  // Track last resources
  private lastTextureWidth = 0;
  private lastTextureHeight = 0;
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastTerrainAtlasView: GPUTextureView | null = null;
  private lastWaveFieldTextureView: GPUTextureView | null = null;
  private lastLightsTextureView: GPUTextureView | null = null;

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
      this.windFieldShader = createWindFieldShader();
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

      // Create boat air rasterizer (publishes per-boat air gap to boatAirTexture)
      this.boatAirShader = new BoatAirShader();

      await Promise.all([
        this.terrainScreenShader.init(),
        this.waterHeightShader.init(),
        this.windFieldShader.init(),
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
      this.windFieldUniformBuffer = device.createBuffer({
        size: WindFieldUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Wind Field Uniform Buffer",
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
      this.windFieldUniforms = WindFieldUniforms.create();
      this.terrainCompositeUniforms = TerrainCompositeUniforms.create();
      this.waterFilterUniforms = WaterFilterUniforms.create();

      this.terrainCompositeUniforms.set.hasTerrainData(0);
      this.waterFilterUniforms.set.hasTerrainData(0);

      // Linear filtering: rgba16float is filterable, so bilinear sampling
      // smooths water height / normals between texels for free.
      this.heightSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
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

      this.windFieldSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        label: "Wind Field Sampler",
      });

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize SurfaceRenderer:", error);
    }
  }

  private initPromise: Promise<void> | null = null;
  private unsubWaterQuality: (() => void) | null = null;
  private unsubRenderScale: (() => void) | null = null;

  @on("add")
  onAdd() {
    this.initPromise = this.ensureInitialized();
    // Force a texture rebuild when the user changes water quality or
    // render scale. Zeroing lastTextureWidth makes ensureTextures see a
    // size mismatch on the next render and recreate the surface textures
    // (and bind groups) at the new resolution.
    const invalidate = () => {
      this.lastTextureWidth = 0;
      this.lastTextureHeight = 0;
    };
    this.unsubWaterQuality = onWaterQualityChange(invalidate);
    this.unsubRenderScale = onRenderScaleChange(invalidate);
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
   *
   * All surface textures are sized (width + 2*margin) × (height + 2*margin)
   * so that screen pixel (i, j) lines up with texel (i + margin, j + margin)
   * exactly. See SurfaceConstants.ts.
   */
  private ensureTextures(width: number, height: number): void {
    if (this.lastTextureWidth === width && this.lastTextureHeight === height) {
      return;
    }

    const device = this.game.getWebGPUDevice();

    // Logical (CSS-pixel) coverage including margin. The surface textures
    // cover this world rectangle; their actual texel resolution is scaled
    // by the user's Render Resolution setting (surfScale). The boat-air
    // texture is the exception — it's read by WaterFilterShader via
    // textureLoad with logical pixel coords, so it stays 1:1 with logical.
    const texW = width + 2 * SURFACE_TEXTURE_MARGIN;
    const texH = height + 2 * SURFACE_TEXTURE_MARGIN;
    const surfScale = getRenderScaleFactor();
    const surfTexW = Math.max(1, Math.round(texW * surfScale));
    const surfTexH = Math.max(1, Math.round(texH * surfScale));

    // Destroy old textures
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture?.destroy();
    this.modifierTexture?.destroy();
    this.boatAirTexture?.destroy();
    this.windFieldTexture?.destroy();

    // Destroy old wetness pipeline (will be recreated with new size)
    this.wetnessPipeline?.destroy();

    // Create terrain height texture (screen-space, sampled from tile atlas)
    this.terrainHeightTexture = device.createTexture({
      size: { width: surfTexW, height: surfTexH },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Height Texture",
    });
    this.terrainHeightView = this.terrainHeightTexture.createView();

    // Create water height texture at reduced resolution. rgba16float packs
    // 4 channels: R=height, G=turbulence, B=dh/dx, A=dh/dy. The gradient is
    // computed analytically inside calculateGerstnerWaves so the filter
    // shader can bilinear-sample a smooth normal field — no finite-diff
    // facets even at half-res. WaterQuality scales further on top of
    // surfScale.
    const waterTexW = Math.max(
      1,
      Math.round(surfTexW * getWaterQualityScale()),
    );
    const waterTexH = Math.max(
      1,
      Math.round(surfTexH * getWaterQualityScale()),
    );
    this.waterHeightTexture = device.createTexture({
      size: { width: waterTexW, height: waterTexH },
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Water Height Texture",
    });
    this.waterHeightView = this.waterHeightTexture.createView();

    // Create boat air texture: per-pixel air gap published by BoatAirShader
    // and consumed by WaterFilterShader. R = bilge surface Z, G = deck cap
    // Z, B = bilge turbulence. Cleared each frame to a low sentinel. Kept
    // at logical (unscaled) resolution because the filter reads it with
    // textureLoad at logical pixel coords.
    this.boatAirTexture = device.createTexture({
      size: { width: texW, height: texH },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Boat Air Texture",
    });
    this.boatAirTextureView = this.boatAirTexture.createView();

    // Create wave field texture array (one layer per wave source)
    this.waveFieldTexture = device.createTexture({
      size: {
        width: surfTexW,
        height: surfTexH,
        depthOrArrayLayers: MAX_WAVE_SOURCES,
      },
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
    const modW = Math.max(1, Math.round(surfTexW * MODIFIER_RESOLUTION_SCALE));
    const modH = Math.max(1, Math.round(surfTexH * MODIFIER_RESOLUTION_SCALE));
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

    // Wind field texture at half-res (wind varies slowly enough that
    // half-resolution sampling is visually indistinguishable but cheaper).
    const windW = Math.ceil(surfTexW / 2);
    const windH = Math.ceil(surfTexH / 2);
    this.windFieldTexture = device.createTexture({
      size: { width: windW, height: windH },
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Wind Field Texture",
    });
    this.windFieldTextureView = this.windFieldTexture.createView({
      label: "Wind Field Texture View",
    });

    // Recreate wetness pipeline with new texture size (shares surface layout)
    this.wetnessPipeline = new WetnessRenderPipeline(
      device,
      surfTexW,
      surfTexH,
    );
    this.wetnessPipeline.init();

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    // Force bind group recreation
    this.terrainScreenBindGroup = null;
    this.waterHeightBindGroup = null;
    this.windFieldBindGroup = null;
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
    texClipToWorld: Matrix3,
    textureWidth: number,
    textureHeight: number,
  ): void {
    if (!this.terrainScreenUniforms || !this.terrainTileCache) return;

    this.terrainScreenUniforms.set.texClipToWorld(texClipToWorld);
    this.terrainScreenUniforms.set.textureWidth(textureWidth);
    this.terrainScreenUniforms.set.textureHeight(textureHeight);

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
    texClipToWorld: Matrix3,
    currentTime: number,
    textureWidth: number,
    textureHeight: number,
    waterResources: WaterResources,
  ): void {
    if (!this.waterHeightUniforms) return;

    this.waterHeightUniforms.set.texClipToWorld(texClipToWorld);
    this.waterHeightUniforms.set.textureWidth(textureWidth);
    this.waterHeightUniforms.set.textureHeight(textureHeight);
    this.waterHeightUniforms.set.time(currentTime);
    this.waterHeightUniforms.set.tideHeight(waterResources.getTideHeight());
    this.waterHeightUniforms.set.numWaves(waterResources.getNumWaves());
    const weather = this.game.entities.tryGetSingleton(WeatherState);
    this.waterHeightUniforms.set.waveAmplitudeScale(
      weather?.waveAmplitudeScale ?? 1.0,
    );
  }

  /**
   * Update uniforms for wind field pass. Pulls base velocity + per-source
   * weights from WindResources. windResources may be null in early frames
   * before the entity is added; in that case the caller skips the pass.
   */
  private updateWindFieldUniforms(
    texClipToWorld: Matrix3,
    textureWidth: number,
    textureHeight: number,
    currentTime: number,
    windResources: WindResources | undefined,
  ): void {
    if (!this.windFieldUniforms) return;

    this.windFieldUniforms.set.texClipToWorld(texClipToWorld);
    this.windFieldUniforms.set.textureWidth(textureWidth);
    this.windFieldUniforms.set.textureHeight(textureHeight);
    this.windFieldUniforms.set.time(currentTime);

    if (windResources) {
      const weather = this.game.entities.tryGetSingleton(WeatherState);
      const baseWind = weather?.getEffectiveWindBase();
      const weights = windResources.getSourceWeights();
      this.windFieldUniforms.set.baseWindX(baseWind?.x ?? 0);
      this.windFieldUniforms.set.baseWindY(baseWind?.y ?? 0);
      this.windFieldUniforms.set.numActiveWindSources(weights.length);
      this.windFieldUniforms.set.weights0(weights[0] ?? 0);
      this.windFieldUniforms.set.weights1(weights[1] ?? 0);
      this.windFieldUniforms.set.weights2(weights[2] ?? 0);
      this.windFieldUniforms.set.weights3(weights[3] ?? 0);
      this.windFieldUniforms.set.weights4(weights[4] ?? 0);
      this.windFieldUniforms.set.weights5(weights[5] ?? 0);
      this.windFieldUniforms.set.weights6(weights[6] ?? 0);
      this.windFieldUniforms.set.weights7(weights[7] ?? 0);
    } else {
      this.windFieldUniforms.set.baseWindX(0);
      this.windFieldUniforms.set.baseWindY(0);
      this.windFieldUniforms.set.numActiveWindSources(0);
      this.windFieldUniforms.set.weights0(0);
      this.windFieldUniforms.set.weights1(0);
      this.windFieldUniforms.set.weights2(0);
      this.windFieldUniforms.set.weights3(0);
      this.windFieldUniforms.set.weights4(0);
      this.windFieldUniforms.set.weights5(0);
      this.windFieldUniforms.set.weights6(0);
      this.windFieldUniforms.set.weights7(0);
    }
  }

  /**
   * Update uniforms for terrain composite pass.
   */
  private updateTerrainCompositeUniforms(
    clipToWorldMatrix: Matrix3,
    weather: WeatherState | undefined,
    width: number,
    height: number,
    waterResources: WaterResources,
    terrainResources: TerrainResources,
  ): void {
    if (!this.terrainCompositeUniforms || !this.terrainTileCache) return;

    this.terrainCompositeUniforms.set.cameraMatrix(clipToWorldMatrix);
    this.terrainCompositeUniforms.set.screenWidth(width);
    this.terrainCompositeUniforms.set.screenHeight(height);
    this.terrainCompositeUniforms.set.pixelRatio(
      this.game.getRenderer().getPixelRatio(),
    );
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

    pushSceneLighting(this.terrainCompositeUniforms.set, weather);
  }

  /**
   * Update uniforms for water filter pass.
   */
  private updateWaterFilterUniforms(
    clipToWorldMatrix: Matrix3,
    worldToTexClipMatrix: Matrix3,
    currentTime: number,
    weather: WeatherState | undefined,
    width: number,
    height: number,
    waterResources: WaterResources,
    terrainResources: TerrainResources,
  ): void {
    if (!this.waterFilterUniforms) return;

    this.waterFilterUniforms.set.cameraMatrix(clipToWorldMatrix);
    this.waterFilterUniforms.set.worldToTexClip(worldToTexClipMatrix);
    this.waterFilterUniforms.set.screenWidth(width);
    this.waterFilterUniforms.set.screenHeight(height);
    this.waterFilterUniforms.set.pixelRatio(
      this.game.getRenderer().getPixelRatio(),
    );
    this.waterFilterUniforms.set.time(currentTime);
    this.waterFilterUniforms.set.tideHeight(waterResources.getTideHeight());
    this.waterFilterUniforms.set.hasTerrainData(terrainResources ? 1 : 0);
    this.waterFilterUniforms.set.chlorophyll(DEFAULT_CHLOROPHYLL);
    this.waterFilterUniforms.set.cdom(DEFAULT_CDOM);
    this.waterFilterUniforms.set.sediment(DEFAULT_SEDIMENT);

    pushWaterTuning(this.waterFilterUniforms);
    pushSceneLighting(this.waterFilterUniforms.set, weather);
  }

  /**
   * Ensure bind groups are up to date.
   */
  private ensureBindGroups(
    waterResources: WaterResources,
    terrainAtlasView: GPUTextureView,
  ): void {
    const waveDataBuffer = waterResources.waveDataBuffer;
    const lightsTextureView = this.game.getRenderer().getLightsTextureView();

    const needsRebuild =
      !this.terrainScreenBindGroup ||
      !this.waterHeightBindGroup ||
      !this.terrainCompositeBindGroup ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
      this.lastTerrainAtlasView !== terrainAtlasView ||
      this.lastWaveFieldTextureView !== this.waveFieldTextureView ||
      this.lastLightsTextureView !== lightsTextureView;

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

    // Water height bind group (pure ocean surface; boat-air substitution
    // moved to the water filter so the height texture stays continuous).
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
      wetnessTextureView &&
      lightsTextureView
    ) {
      this.terrainCompositeBindGroup =
        this.terrainCompositeShader.createBindGroup({
          params: { buffer: this.terrainCompositeUniformBuffer },
          terrainTileAtlas: terrainAtlasView,
          wetnessTexture: wetnessTextureView,
          biomeParams: { buffer: this.biomeUniformBuffer },
          lightsTexture: lightsTextureView,
        });
    }

    // Note: water filter bind group is rebuilt separately in
    // rebuildWaterFilterBindGroup() right before the filter pass, after
    // depth and color copies produce their readable views.

    // Update tracking
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastTerrainAtlasView = terrainAtlasView;
    this.lastWaveFieldTextureView = this.waveFieldTextureView;
    this.lastLightsTextureView = lightsTextureView;
  }

  private ensureWindFieldBindGroup(windResources: WindResources): void {
    const windMeshBuffer = windResources.getPackedWindMeshBuffer();

    const needsRebuild =
      !this.windFieldBindGroup || this.lastWindMeshBuffer !== windMeshBuffer;
    if (!needsRebuild) return;

    if (
      !this.windFieldShader ||
      !this.windFieldUniformBuffer ||
      !this.windFieldTextureView
    ) {
      return;
    }

    this.windFieldBindGroup = this.windFieldShader.createBindGroup({
      params: { buffer: this.windFieldUniformBuffer },
      packedWindMesh: { buffer: windMeshBuffer },
      outputTexture: this.windFieldTextureView,
    });

    this.lastWindMeshBuffer = windMeshBuffer;
  }

  /**
   * Rebuild the water filter bind group with current scene color and depth
   * copy views. Called right before the water filter pass.
   */
  private rebuildWaterFilterBindGroup(
    sceneColorView: GPUTextureView | null,
    sceneDepthView: GPUTextureView | null,
  ): void {
    const lightsTextureView = this.game.getRenderer().getLightsTextureView();
    if (
      this.waterFilterShader &&
      this.waterFilterUniformBuffer &&
      this.waterHeightView &&
      this.heightSampler &&
      this.boatAirTextureView &&
      this.windFieldTextureView &&
      this.windFieldSampler &&
      lightsTextureView &&
      sceneColorView &&
      sceneDepthView
    ) {
      this.waterFilterBindGroup = this.waterFilterShader.createBindGroup({
        params: { buffer: this.waterFilterUniformBuffer },
        boatAirTexture: this.boatAirTextureView,
        sceneColorTexture: sceneColorView,
        sceneDepthTexture: sceneDepthView,
        waterHeightTexture: this.waterHeightView,
        heightSampler: this.heightSampler,
        windFieldTexture: this.windFieldTextureView,
        windFieldSampler: this.windFieldSampler,
        lightsTexture: lightsTextureView,
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

    const expandedViewport = profiler.measure("viewport", () =>
      this.getExpandedViewport(TILE_CACHE_VIEWPORT_MARGIN),
    );

    const { weather, currentTime } = profiler.measure("timeOfDay", () => {
      const tod = this.game.entities.tryGetSingleton(TimeOfDay);
      const w = this.game.entities.tryGetSingleton(WeatherState);
      const t = tod ? tod.getTimeInSeconds() : this.game.elapsedUnpausedTime;
      // Push the current ambient illumination to the generic shape pipeline so
      // every `draw.*` call this frame picks up day/night tinting automatically.
      // Callers opt out by setting `ignoreLight: true` in DrawOptions.
      if (w) {
        const [ar, ag, ab] = w.getAmbientLight();
        renderer.setAmbientLight(ar, ag, ab);
      } else {
        renderer.setAmbientLight(1, 1, 1);
      }
      return { weather: w, currentTime: t };
    });

    const {
      wavePhysicsResources,
      waterResources,
      terrainResources,
      windResources,
    } = profiler.measure("singletons", () => ({
      wavePhysicsResources:
        this.game.entities.tryGetSingleton(WavePhysicsResources),
      waterResources: this.game.entities.getSingleton(WaterResources),
      terrainResources: this.game.entities.getSingleton(TerrainResources),
      windResources: this.game.entities.tryGetSingleton(WindResources),
    }));

    // Hand the current render viewport to WaterResources so the next
    // tick's modifier upload can partition visible-first. Wakes whose
    // AABB is entirely outside this rect won't be rasterized into the
    // modifier texture.
    waterResources.setRenderViewport(expandedViewport);

    profiler.measure("ensureTextures", () => {
      this.ensureTextures(width, height);
    });

    const { texClipToWorldMatrix, worldToTexClipMatrix, clipToWorldMatrix } =
      profiler.measure("matrices", () => {
        // Compute clip-to-world matrix: maps clip space (-1,1) directly to world space.
        // Composed as: screenToWorld * clipToScreen
        // Note: clipToScreen does NOT flip Y here. The old UV-based clipToWorld used
        // uvY = -clipY*0.5+0.5, which combined with the viewport bounds produced a
        // mapping equivalent to clip(-1,-1)→screen(0,0). The camera inverse already
        // handles the world Y-up ↔ screen Y-down conversion.
        const clipToScreen = new Matrix3();
        clipToScreen.translate(width / 2, height / 2);
        clipToScreen.scale(width / 2, height / 2);
        const c2w = camera.getMatrix().clone().invert();
        c2w.multiply(clipToScreen);

        // Screen-aligned mapping for the surface textures.
        const tw = width + 2 * SURFACE_TEXTURE_MARGIN;
        const th = height + 2 * SURFACE_TEXTURE_MARGIN;
        const tc2w = c2w.clone().scale(tw / width, th / height);
        const w2tc = tc2w.clone().invert();
        return {
          clipToWorldMatrix: c2w,
          texClipToWorldMatrix: tc2w,
          worldToTexClipMatrix: w2tc,
        };
      });

    const texW = width + 2 * SURFACE_TEXTURE_MARGIN;
    const texH = height + 2 * SURFACE_TEXTURE_MARGIN;
    // Surface compute textures are scaled by Render Resolution. Matrix
    // math (which lives off texW/texH directly) is unscaled because the
    // texture covers the same world rect regardless of resolution.
    const surfScale = getRenderScaleFactor();
    const surfTexW = Math.max(1, Math.round(texW * surfScale));
    const surfTexH = Math.max(1, Math.round(texH * surfScale));

    // === Terrain Tile Cache Update ===
    const terrainAtlasView = profiler.measure("terrainTiles", () => {
      profiler.measure("checkInvalidation", () => {
        this.terrainTileCache!.checkInvalidation(terrainResources);
      });

      // Update tile cache and get tiles that need rendering
      // Pass camera.z (zoom level) for LOD selection
      const tileRequests = profiler.measure("update", () =>
        this.terrainTileCache!.update(
          expandedViewport,
          camera.z,
          terrainResources,
        ),
      );

      // Render any missing tiles (current LOD + budget-limited adjacent pre-warming)
      profiler.measure("renderTiles", () => {
        this.terrainTileCache!.renderTiles(
          tileRequests,
          terrainResources,
          gpuProfiler ?? undefined,
        );
      });

      return this.terrainTileCache!.getAtlasView();
    });

    const windTexW = Math.ceil(surfTexW / 2);
    const windTexH = Math.ceil(surfTexH / 2);
    const waterTexW = Math.max(
      1,
      Math.round(surfTexW * getWaterQualityScale()),
    );
    const waterTexH = Math.max(
      1,
      Math.round(surfTexH * getWaterQualityScale()),
    );

    profiler.measure("uniforms", () => {
      // Update all uniforms. Compute shaders dispatch one invocation per
      // surface-texture texel, so they receive texW × texH. Fragment shaders
      // still use screen width/height for pixel-space math (e.g. normal eps).
      this.updateTerrainScreenUniforms(
        texClipToWorldMatrix,
        surfTexW,
        surfTexH,
      );
      this.updateWaterHeightUniforms(
        texClipToWorldMatrix,
        currentTime,
        waterTexW,
        waterTexH,
        waterResources,
      );
      this.updateWindFieldUniforms(
        texClipToWorldMatrix,
        windTexW,
        windTexH,
        currentTime,
        windResources,
      );
      this.updateTerrainCompositeUniforms(
        clipToWorldMatrix,
        weather,
        width,
        height,
        waterResources,
        terrainResources,
      );
      this.updateWaterFilterUniforms(
        clipToWorldMatrix,
        worldToTexClipMatrix,
        currentTime,
        weather,
        width,
        height,
        waterResources,
        terrainResources,
      );

      // Upload uniforms
      this.terrainScreenUniforms?.uploadTo(this.terrainScreenUniformBuffer!);
      this.waterHeightUniforms?.uploadTo(this.waterHeightUniformBuffer!);
      this.windFieldUniforms?.uploadTo(this.windFieldUniformBuffer!);
      this.terrainCompositeUniforms?.uploadTo(
        this.terrainCompositeUniformBuffer!,
      );
      this.waterFilterUniforms?.uploadTo(this.waterFilterUniformBuffer!);
    });

    profiler.measure("bindGroups", () => {
      this.ensureBindGroups(waterResources, terrainAtlasView);
      if (windResources) {
        this.ensureWindFieldBindGroup(windResources);
      }
    });

    // === Pass 1: Terrain Screen Compute ===
    // Sample terrain atlas to screen-space texture for water height shader
    profiler.measure("terrainScreen", () => {
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
          surfTexW,
          surfTexH,
        );
        computePass.end();
        device.queue.submit([commandEncoder.finish()]);
      }
    });

    // === Pass 1.25: Wind Field Compute ===
    // Writes per-texel wind velocity to a half-res screen-space texture
    // for downstream consumers (water filter ripple shading, whitecaps).
    profiler.measure("windField", () => {
      if (windResources && this.windFieldShader && this.windFieldBindGroup) {
        const commandEncoder = device.createCommandEncoder({
          label: "Wind Field Compute",
        });
        const computePass = commandEncoder.beginComputePass({
          label: "Wind Field Compute Pass",
          timestampWrites:
            gpuProfiler?.getComputeTimestampWrites("surface.wind"),
        });
        this.windFieldShader.dispatch(
          computePass,
          this.windFieldBindGroup,
          windTexW,
          windTexH,
        );
        computePass.end();
        device.queue.submit([commandEncoder.finish()]);
      }
    });

    // === Pass 1.5: Wave Field Rasterization ===
    // Rasterize wavefront meshes to screen-space texture array
    profiler.measure("waveField", () => {
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
            worldToTexClipMatrix,
            this.waveFieldTexture,
            gpuProfiler,
          );
          device.queue.submit([commandEncoder.finish()]);
        }
      }
    });

    // === Pass 1.75: Modifier Rasterization ===
    // Rasterize wake/ripple contributions to screen-space texture
    profiler.measure("modifier", () => {
      if (this.modifierRasterizer && this.modifierTexture) {
        const commandEncoder = device.createCommandEncoder({
          label: "Modifier Rasterization",
        });
        this.modifierRasterizer.render(
          commandEncoder,
          waterResources.modifiersBuffer,
          waterResources.getVisibleModifierCount(),
          worldToTexClipMatrix,
          this.modifierTexture,
          gpuProfiler,
        );
        device.queue.submit([commandEncoder.finish()]);
      }
    });

    // === Pass 1.8: Boat Air Rasterization ===
    // Rasterize each boat's air gap (bilge surface Z + deck cap Z) into
    // boatAirTexture. The water height compute reads this and substitutes
    // the bilge surface for the ocean wherever the ocean would lie inside
    // an air column. One uniform per-pixel mechanism handles dry boats,
    // wet bilges, partial submersion, and full submersion.
    profiler.measure("boatAir", () => {
      if (this.boatAirShader && this.boatAirTextureView) {
        const boat = this.game.entities.getById("boat") as Boat | undefined;
        if (boat) {
          this.boatAirShader.render(
            this.boatAirTextureView,
            worldToTexClipMatrix,
            boat,
          );
        } else {
          // No boat — clear the air texture to "no air anywhere" so the
          // water height compute's substitution is a no-op.
          this.boatAirShader.clear(this.boatAirTextureView);
        }
      }
    });

    // === Pass 2: Water Height Compute ===
    profiler.measure("waterHeight", () => {
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
          waterTexW,
          waterTexH,
        );
        computePass.end();
        device.queue.submit([commandEncoder.finish()]);
      }
    });

    // === Wetness Update Pass ===
    if (
      this.wetnessPipeline &&
      this.wetnessPipeline.isInitialized() &&
      this.waterHeightView &&
      this.terrainHeightView
    ) {
      // Wetness texture shares the screen-space layout of water/terrain.
      this.wetnessPipeline.update(
        texClipToWorldMatrix,
        worldToTexClipMatrix,
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
    profiler.measure("terrainComposite", () => {
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
    });

    // Copy depth and color so the water filter can read the frozen scene.
    // Ordering: terrain composite → copyDepthBuffer → copyColorBuffer.
    // copyColorBuffer switches the active render target from mainColorTexture
    // to the swapchain; subsequent draw calls go to the final frame output.
    profiler.measure("copyBuffers", () => {
      webgpuRenderer.copyDepthBuffer();
      webgpuRenderer.copyColorBuffer();

      const sceneColorView = webgpuRenderer.getColorCopyTextureView();
      const sceneDepthView = webgpuRenderer.getDepthCopyTextureView();
      this.rebuildWaterFilterBindGroup(sceneColorView, sceneDepthView);
    });

    // === Pass 3b: Water Filter (fragment) ===
    // Applies physically-based absorption to the frozen scene and writes
    // the final composited pixel to the swapchain. Post-water particles
    // (wake) render on top in their own layers afterward.
    profiler.measure("waterFilter", () => {
      const filterPass = renderer.getCurrentRenderPass();
      if (filterPass && this.waterFilterShader && this.waterFilterBindGroup) {
        this.waterFilterShader.render(filterPass, this.waterFilterBindGroup);
      }
    });
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
    this.windFieldShader?.destroy();
    this.terrainCompositeShader?.destroy();
    this.waterFilterShader?.destroy();
    this.terrainTileCache?.destroy();
    this.wetnessPipeline?.destroy();
    this.modifierRasterizer?.destroy();
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture?.destroy();
    this.modifierTexture?.destroy();
    this.windFieldTexture?.destroy();
    this.terrainScreenUniformBuffer?.destroy();
    this.waterHeightUniformBuffer?.destroy();
    this.windFieldUniformBuffer?.destroy();
    this.terrainCompositeUniformBuffer?.destroy();
    this.waterFilterUniformBuffer?.destroy();
    this.biomeUniformBuffer?.destroy();
    this.unsubWaterQuality?.();
    this.unsubWaterQuality = null;
    this.unsubRenderScale?.();
    this.unsubRenderScale = null;
  }
}
