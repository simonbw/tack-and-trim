/**
 * Owns the surface-rendering shaders, their uniform buffers + uniform
 * instances, samplers, and bind groups. Provides per-frame `update*` helpers
 * that pack scene state into the uniform instances and `ensure*BindGroup`
 * helpers that rebuild bind groups when their source resources change.
 *
 * SurfaceRenderer constructs an instance, calls `init()` once, then drives
 * the per-frame update + bind-group methods from its render pass.
 */

import { Matrix3 } from "../../core/graphics/Matrix3";
import {
  createUniformBuffer,
  type UniformInstance,
} from "../../core/graphics/UniformStruct";
import type { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import type { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { createLinearClampSampler } from "../../core/graphics/webgpu/Samplers";
import type { Game } from "../../core/Game";
import { pushSceneLighting } from "../time/SceneLighting";
import type { WeatherState } from "../weather/WeatherState";
import { WeatherState as WeatherStateClass } from "../weather/WeatherState";
import { WaterResources } from "../world/water/WaterResources";
import { WindResources } from "../world/wind/WindResources";
import {
  BIOME_BUFFER_SIZE,
  packBiomeBuffer,
  type BiomeConfig,
} from "./BiomeConfig";
import type { LODTerrainTileCache } from "./LODTerrainTileCache";
import type { SurfaceTextures } from "./SurfaceTextures";
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
import { pushWaterTuning } from "./WaterTuning";
import type { WetnessRenderPipeline } from "./WetnessRenderPipeline";
import { createWindFieldShader, WindFieldUniforms } from "./WindFieldShader";

// Default bio-optical water chemistry. These drive the water filter's
// absorption/scattering computation. Eventually they should come from the
// level's BiomeConfig / region file; for now they're clean-coastal defaults.
//   chlorophyll: mg/m³     — 0.01 open ocean, 1 coastal, 10 bloom
//   cdom:        normalized — 0 clean, 1 typical coastal, 2+ tannic
//   sediment:    normalized — 0 clean, 1 typical coastal, 3 turbid
const DEFAULT_CHLOROPHYLL = 0.5;
const DEFAULT_CDOM = 0.3;
const DEFAULT_SEDIMENT = 0.4;

export class SurfaceShaders {
  // Shaders
  terrainScreenShader: ComputeShader | null = null;
  waterHeightShader: ComputeShader | null = null;
  windFieldShader: ComputeShader | null = null;
  terrainCompositeShader: FullscreenShader | null = null;
  waterFilterShader: FullscreenShader | null = null;

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

  // Samplers
  private heightSampler: GPUSampler | null = null;
  private waveFieldSampler: GPUSampler | null = null;
  private modifierSampler: GPUSampler | null = null;
  private windFieldSampler: GPUSampler | null = null;

  // Bind groups (recreated when resources change)
  terrainScreenBindGroup: GPUBindGroup | null = null;
  waterHeightBindGroup: GPUBindGroup | null = null;
  windFieldBindGroup: GPUBindGroup | null = null;
  terrainCompositeBindGroup: GPUBindGroup | null = null;
  waterFilterBindGroup: GPUBindGroup | null = null;

  // Tracked for bind-group invalidation
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastTerrainAtlasView: GPUTextureView | null = null;
  private lastWaveFieldTextureView: GPUTextureView | null = null;
  private lastLightsTextureView: GPUTextureView | null = null;
  private lastWindMeshBuffer: GPUBuffer | null = null;

  constructor(
    private readonly game: Game,
    private readonly textures: SurfaceTextures,
    private readonly biomeConfig: BiomeConfig,
  ) {}

  /**
   * Create shaders, samplers, uniform buffers, and uniform instances. Must
   * be called before any `update*` or `ensure*BindGroup` method.
   */
  async init(): Promise<void> {
    const device = this.game.getWebGPUDevice();

    // Create shaders
    this.terrainScreenShader = createTerrainScreenShader();
    this.waterHeightShader = createWaterHeightShader();
    this.windFieldShader = createWindFieldShader();
    this.terrainCompositeShader = createTerrainCompositeShader();
    this.waterFilterShader = createWaterFilterShader();

    await Promise.all([
      this.terrainScreenShader.init(),
      this.waterHeightShader.init(),
      this.windFieldShader.init(),
      this.terrainCompositeShader.init(),
      this.waterFilterShader.init(),
    ]);

    // Create uniform buffers
    this.terrainScreenUniformBuffer = createUniformBuffer(
      device,
      TerrainScreenUniforms,
      "Terrain Screen Uniform Buffer",
    );
    this.waterHeightUniformBuffer = createUniformBuffer(
      device,
      WaterHeightUniforms,
      "Water Height Uniform Buffer",
    );
    this.windFieldUniformBuffer = createUniformBuffer(
      device,
      WindFieldUniforms,
      "Wind Field Uniform Buffer",
    );
    this.terrainCompositeUniformBuffer = createUniformBuffer(
      device,
      TerrainCompositeUniforms,
      "Terrain Composite Uniform Buffer",
    );
    this.waterFilterUniformBuffer = createUniformBuffer(
      device,
      WaterFilterUniforms,
      "Water Filter Uniform Buffer",
    );

    // Biome uniform buffer — uploaded once per level load
    this.biomeUniformBuffer = createUniformBuffer(
      device,
      { byteSize: BIOME_BUFFER_SIZE },
      "Biome Uniform Buffer",
    );
    const biomeData = packBiomeBuffer(this.biomeConfig);
    device.queue.writeBuffer(this.biomeUniformBuffer, 0, biomeData.buffer);

    // Create uniform instances
    this.terrainScreenUniforms = TerrainScreenUniforms.create();
    this.waterHeightUniforms = WaterHeightUniforms.create();
    this.windFieldUniforms = WindFieldUniforms.create();
    this.terrainCompositeUniforms = TerrainCompositeUniforms.create();
    this.waterFilterUniforms = WaterFilterUniforms.create();

    // All four samplers use linear filtering with clamp-to-edge — the
    // standard descriptor for screen-space surface textures. rgba16float
    // is filterable, so bilinear sampling smooths water height / normals
    // between texels for free.
    this.heightSampler = createLinearClampSampler(
      device,
      "Height Texture Sampler",
    );
    this.waveFieldSampler = createLinearClampSampler(
      device,
      "Wave Field Sampler",
    );
    this.modifierSampler = createLinearClampSampler(device, "Modifier Sampler");
    this.windFieldSampler = createLinearClampSampler(
      device,
      "Wind Field Sampler",
    );
  }

  /**
   * Force every bind group to be rebuilt on the next ensure*BindGroup call.
   * Called after `SurfaceTextures.ensure()` reports a rebuild — bind groups
   * reference the destroyed texture views.
   */
  invalidateBindGroups(): void {
    this.terrainScreenBindGroup = null;
    this.waterHeightBindGroup = null;
    this.windFieldBindGroup = null;
    this.terrainCompositeBindGroup = null;
    this.waterFilterBindGroup = null;
  }

  // === Per-frame uniform updates =========================================

  updateTerrainScreenUniforms(
    texClipToWorld: Matrix3,
    textureWidth: number,
    textureHeight: number,
    terrainTileCache: LODTerrainTileCache,
  ): void {
    if (!this.terrainScreenUniforms) return;

    this.terrainScreenUniforms.set.texClipToWorld(texClipToWorld);
    this.terrainScreenUniforms.set.textureWidth(textureWidth);
    this.terrainScreenUniforms.set.textureHeight(textureHeight);

    const atlasInfo = terrainTileCache.getAtlasInfo();
    this.terrainScreenUniforms.set.atlasTileSize(atlasInfo.tileSize);
    this.terrainScreenUniforms.set.atlasTilesX(atlasInfo.tilesX);
    this.terrainScreenUniforms.set.atlasTilesY(atlasInfo.tilesY);
    this.terrainScreenUniforms.set.atlasWorldUnitsPerTile(
      atlasInfo.worldUnitsPerTile,
    );
  }

  updateWaterHeightUniforms(
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
    const weather = this.game.entities.tryGetSingleton(WeatherStateClass);
    this.waterHeightUniforms.set.waveAmplitudeScale(
      weather?.waveAmplitudeScale ?? 1.0,
    );
  }

  /**
   * Update uniforms for wind field pass. Pulls base velocity + per-source
   * weights from WindResources. windResources may be null in early frames
   * before the entity is added; in that case the caller skips the pass.
   */
  updateWindFieldUniforms(
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
      const weather = this.game.entities.tryGetSingleton(WeatherStateClass);
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

  updateTerrainCompositeUniforms(
    clipToWorldMatrix: Matrix3,
    weather: WeatherState | undefined,
    width: number,
    height: number,
    waterResources: WaterResources,
    terrainTileCache: LODTerrainTileCache,
  ): void {
    if (!this.terrainCompositeUniforms) return;

    this.terrainCompositeUniforms.set.cameraMatrix(clipToWorldMatrix);
    this.terrainCompositeUniforms.set.screenWidth(width);
    this.terrainCompositeUniforms.set.screenHeight(height);
    this.terrainCompositeUniforms.set.pixelRatio(
      this.game.getRenderer().getPixelRatio(),
    );
    this.terrainCompositeUniforms.set.tideHeight(
      waterResources.getTideHeight(),
    );

    const atlasInfo = terrainTileCache.getAtlasInfo();
    this.terrainCompositeUniforms.set.atlasTileSize(atlasInfo.tileSize);
    this.terrainCompositeUniforms.set.atlasTilesX(atlasInfo.tilesX);
    this.terrainCompositeUniforms.set.atlasTilesY(atlasInfo.tilesY);
    this.terrainCompositeUniforms.set.atlasWorldUnitsPerTile(
      atlasInfo.worldUnitsPerTile,
    );

    pushSceneLighting(this.terrainCompositeUniforms.set, weather);
  }

  updateWaterFilterUniforms(
    clipToWorldMatrix: Matrix3,
    worldToTexClipMatrix: Matrix3,
    currentTime: number,
    weather: WeatherState | undefined,
    width: number,
    height: number,
    waterResources: WaterResources,
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
    this.waterFilterUniforms.set.chlorophyll(DEFAULT_CHLOROPHYLL);
    this.waterFilterUniforms.set.cdom(DEFAULT_CDOM);
    this.waterFilterUniforms.set.sediment(DEFAULT_SEDIMENT);

    pushWaterTuning(this.waterFilterUniforms);
    pushSceneLighting(this.waterFilterUniforms.set, weather);
  }

  /**
   * Upload all five uniform instances to their GPU buffers. Call once per
   * frame after running the `update*Uniforms` methods.
   */
  uploadAllUniforms(): void {
    this.terrainScreenUniforms?.uploadTo(this.terrainScreenUniformBuffer!);
    this.waterHeightUniforms?.uploadTo(this.waterHeightUniformBuffer!);
    this.windFieldUniforms?.uploadTo(this.windFieldUniformBuffer!);
    this.terrainCompositeUniforms?.uploadTo(
      this.terrainCompositeUniformBuffer!,
    );
    this.waterFilterUniforms?.uploadTo(this.waterFilterUniformBuffer!);
  }

  // === Bind groups ========================================================

  /**
   * Build / refresh terrain-screen, water-height, and terrain-composite
   * bind groups. The water filter bind group is rebuilt separately each
   * frame in `rebuildWaterFilterBindGroup` after the depth/color copies.
   */
  ensureBindGroups(
    waterResources: WaterResources,
    terrainAtlasView: GPUTextureView,
    wetnessPipeline: WetnessRenderPipeline | null,
  ): void {
    const waveDataBuffer = waterResources.waveDataBuffer;
    const lightsTextureView = this.game.getRenderer().getLightsTextureView();
    const waveFieldTextureView = this.textures.waveFieldTextureView;

    const needsRebuild =
      !this.terrainScreenBindGroup ||
      !this.waterHeightBindGroup ||
      !this.terrainCompositeBindGroup ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
      this.lastTerrainAtlasView !== terrainAtlasView ||
      this.lastWaveFieldTextureView !== waveFieldTextureView ||
      this.lastLightsTextureView !== lightsTextureView;

    if (!needsRebuild) return;

    // Terrain screen bind group (samples atlas → screen-space texture)
    if (
      this.terrainScreenShader &&
      this.terrainScreenUniformBuffer &&
      this.textures.terrainHeightView
    ) {
      this.terrainScreenBindGroup = this.terrainScreenShader.createBindGroup({
        params: { buffer: this.terrainScreenUniformBuffer },
        terrainTileAtlas: terrainAtlasView,
        outputTexture: this.textures.terrainHeightView,
      });
    }

    // Water height bind group (pure ocean surface; boat-air substitution
    // moved to the water filter so the height texture stays continuous).
    if (
      this.waterHeightShader &&
      this.waterHeightUniformBuffer &&
      this.textures.waterHeightView &&
      waveFieldTextureView &&
      this.waveFieldSampler &&
      this.textures.modifierTextureView &&
      this.modifierSampler
    ) {
      this.waterHeightBindGroup = this.waterHeightShader.createBindGroup({
        params: { buffer: this.waterHeightUniformBuffer },
        waveData: { buffer: waveDataBuffer },
        modifierTexture: this.textures.modifierTextureView,
        modifierSampler: this.modifierSampler,
        waveFieldTexture: waveFieldTextureView,
        waveFieldSampler: this.waveFieldSampler,
        outputTexture: this.textures.waterHeightView,
      });
    }

    // Terrain composite bind group (stable — reads only compute outputs)
    const wetnessTextureView = wetnessPipeline?.getOutputTextureView();
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

    // Update tracking
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastTerrainAtlasView = terrainAtlasView;
    this.lastWaveFieldTextureView = waveFieldTextureView;
    this.lastLightsTextureView = lightsTextureView;
  }

  ensureWindFieldBindGroup(windResources: WindResources): void {
    const windMeshBuffer = windResources.getPackedWindMeshBuffer();

    const needsRebuild =
      !this.windFieldBindGroup || this.lastWindMeshBuffer !== windMeshBuffer;
    if (!needsRebuild) return;

    if (
      !this.windFieldShader ||
      !this.windFieldUniformBuffer ||
      !this.textures.windFieldTextureView
    ) {
      return;
    }

    this.windFieldBindGroup = this.windFieldShader.createBindGroup({
      params: { buffer: this.windFieldUniformBuffer },
      packedWindMesh: { buffer: windMeshBuffer },
      outputTexture: this.textures.windFieldTextureView,
    });

    this.lastWindMeshBuffer = windMeshBuffer;
  }

  /**
   * Rebuild the water filter bind group with current scene color and depth
   * copy views. Called right before the water filter pass.
   */
  rebuildWaterFilterBindGroup(
    sceneColorView: GPUTextureView | null,
    sceneDepthView: GPUTextureView | null,
  ): void {
    const lightsTextureView = this.game.getRenderer().getLightsTextureView();
    if (
      this.waterFilterShader &&
      this.waterFilterUniformBuffer &&
      this.textures.waterHeightView &&
      this.heightSampler &&
      this.textures.boatAirTextureView &&
      this.textures.windFieldTextureView &&
      this.windFieldSampler &&
      lightsTextureView &&
      sceneColorView &&
      sceneDepthView
    ) {
      this.waterFilterBindGroup = this.waterFilterShader.createBindGroup({
        params: { buffer: this.waterFilterUniformBuffer },
        boatAirTexture: this.textures.boatAirTextureView,
        sceneColorTexture: sceneColorView,
        sceneDepthTexture: sceneDepthView,
        waterHeightTexture: this.textures.waterHeightView,
        heightSampler: this.heightSampler,
        windFieldTexture: this.textures.windFieldTextureView,
        windFieldSampler: this.windFieldSampler,
        lightsTexture: lightsTextureView,
      });
    }
  }

  destroy(): void {
    this.terrainScreenShader?.destroy();
    this.waterHeightShader?.destroy();
    this.windFieldShader?.destroy();
    this.terrainCompositeShader?.destroy();
    this.waterFilterShader?.destroy();
    this.terrainScreenUniformBuffer?.destroy();
    this.waterHeightUniformBuffer?.destroy();
    this.windFieldUniformBuffer?.destroy();
    this.terrainCompositeUniformBuffer?.destroy();
    this.waterFilterUniformBuffer?.destroy();
    this.biomeUniformBuffer?.destroy();
  }
}
