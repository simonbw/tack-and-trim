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
 *
 * Implementation is split across three files:
 * - SurfaceRenderer (this file): orchestrator. Owns lifecycle, the per-frame
 *   render-pass order, and the composed pieces (terrain tile cache,
 *   wetness pipeline, modifier rasterizer, boat-air rasterizer).
 * - SurfaceTextures: owns the screen-sized GPU textures + their views and
 *   resizes them when render scale / quality changes.
 * - SurfaceShaders: owns the shader instances, samplers, uniform buffers,
 *   per-frame uniform packing, and bind-group construction.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { Matrix3 } from "../../core/graphics/Matrix3";
import { profiler } from "../../core/util/Profiler";
import type { Boat } from "../boat/Boat";
import { TimeOfDay } from "../time/TimeOfDay";
import { WeatherState } from "../weather/WeatherState";
import {
  WavePhysicsResources,
  type Viewport,
} from "../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WaterResources } from "../world/water/WaterResources";
import { WindResources } from "../world/wind/WindResources";
import { DEFAULT_BIOME_CONFIG, type BiomeConfig } from "./BiomeConfig";
import { BoatAirShader } from "./BoatAirShader";
import { LODTerrainTileCache } from "./LODTerrainTileCache";
import { ModifierRasterizer } from "./ModifierRasterizer";
import { SURFACE_TEXTURE_MARGIN } from "./SurfaceConstants";
import { SurfaceShaders } from "./SurfaceShaders";
import { computeSurfaceTextureSizes, SurfaceTextures } from "./SurfaceTextures";
import { onWaterQualityChange } from "./WaterQualityState";
import { onRenderScaleChange } from "../../core/graphics/RenderScaleState";
import { WetnessRenderPipeline } from "./WetnessRenderPipeline";

// World viewport margin for the terrain tile cache. Independent of the
// texture-pixel margin — this drives which tiles the cache keeps hot.
const TILE_CACHE_VIEWPORT_MARGIN = 0.1;

/**
 * Surface renderer entity using multi-pass rendering.
 */
export class SurfaceRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "surface" as const;

  private initialized = false;
  private enabled = false;

  private textures: SurfaceTextures | null = null;
  private shaders: SurfaceShaders | null = null;

  // LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
  private terrainTileCache: LODTerrainTileCache | null = null;

  // Wetness render pipeline (tracks sand wetness over time)
  private wetnessPipeline: WetnessRenderPipeline | null = null;

  // Modifier rasterizer (wakes, ripples → screen-space texture)
  private modifierRasterizer: ModifierRasterizer | null = null;

  // Boat air rasterizer — feeds boatAirTexture to the water filter shader.
  private boatAirShader: BoatAirShader | null = null;

  private biomeConfig: BiomeConfig;
  private initPromise: Promise<void> | null = null;
  private unsubWaterQuality: (() => void) | null = null;
  private unsubRenderScale: (() => void) | null = null;

  constructor(biomeConfig?: BiomeConfig) {
    super();
    this.biomeConfig = biomeConfig ?? DEFAULT_BIOME_CONFIG;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    const device = this.game.getWebGPUDevice();

    this.textures = new SurfaceTextures(device);
    this.shaders = new SurfaceShaders(
      this.game,
      this.textures,
      this.biomeConfig,
    );

    // LOD terrain tile cache (multiple LOD levels for extreme zoom ranges)
    // Supports zoom range 0.02 to 1.0+ by using progressively larger world units per tile.
    this.terrainTileCache = new LODTerrainTileCache(device);

    // Wetness render pipeline; resized in step with the surface textures.
    this.wetnessPipeline = new WetnessRenderPipeline(device, 1, 1);

    this.modifierRasterizer = new ModifierRasterizer(device);
    this.boatAirShader = new BoatAirShader();

    await Promise.all([
      this.shaders.init(),
      this.terrainTileCache.init(),
      this.wetnessPipeline.init(),
      this.modifierRasterizer.init(),
    ]);

    this.initialized = true;
  }

  @on("add")
  onAdd() {
    this.initPromise = this.ensureInitialized();
    // Force a texture rebuild when the user changes water quality or
    // render scale. The textures helper sees a size mismatch on the next
    // render and recreates the surface textures (and bind groups) at the
    // new resolution.
    const invalidate = () => {
      this.textures?.invalidate();
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
   * Ensure intermediate textures exist and match screen size. Recreates the
   * wetness pipeline and invalidates bind groups when the textures rebuild.
   */
  private ensureSurfaceTextures(width: number, height: number): void {
    if (!this.textures || !this.shaders) return;

    const rebuilt = this.textures.ensure(width, height);
    if (!rebuilt) return;

    const { surfTexW, surfTexH } = computeSurfaceTextureSizes(width, height);

    // Resize the wetness textures in place (keeps the shader, no async recompile).
    this.wetnessPipeline?.resize(surfTexW, surfTexH);

    // Bind groups reference the now-destroyed texture views; force a rebuild.
    this.shaders.invalidateBindGroups();
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

  @on("render")
  onRender(event: { dt: number; draw: Draw }) {
    if (
      !this.initialized ||
      !this.terrainTileCache ||
      !this.textures ||
      !this.shaders ||
      !this.enabled
    ) {
      return;
    }

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const gpuProfiler = renderer.getGpuProfiler();
    const device = this.game.getWebGPUDevice();
    const shaders = this.shaders;
    const textures = this.textures;

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
      this.ensureSurfaceTextures(width, height);
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

    const { surfTexW, surfTexH, waterTexW, waterTexH, windTexW, windTexH } =
      computeSurfaceTextureSizes(width, height);

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

    profiler.measure("uniforms", () => {
      // Update all uniforms. Compute shaders dispatch one invocation per
      // surface-texture texel, so they receive texW × texH. Fragment shaders
      // still use screen width/height for pixel-space math (e.g. normal eps).
      shaders.updateTerrainScreenUniforms(
        texClipToWorldMatrix,
        surfTexW,
        surfTexH,
        this.terrainTileCache!,
      );
      shaders.updateWaterHeightUniforms(
        texClipToWorldMatrix,
        currentTime,
        waterTexW,
        waterTexH,
        waterResources,
      );
      shaders.updateWindFieldUniforms(
        texClipToWorldMatrix,
        windTexW,
        windTexH,
        currentTime,
        windResources,
      );
      shaders.updateTerrainCompositeUniforms(
        clipToWorldMatrix,
        weather,
        width,
        height,
        waterResources,
        this.terrainTileCache!,
      );
      shaders.updateWaterFilterUniforms(
        clipToWorldMatrix,
        worldToTexClipMatrix,
        currentTime,
        weather,
        width,
        height,
        waterResources,
      );

      shaders.uploadAllUniforms();
    });

    profiler.measure("bindGroups", () => {
      shaders.ensureBindGroups(
        waterResources,
        terrainAtlasView,
        this.wetnessPipeline,
      );
      if (windResources) {
        shaders.ensureWindFieldBindGroup(windResources);
      }
    });

    // === Pass 1: Terrain Screen Compute ===
    // Sample terrain atlas to screen-space texture for water height shader
    profiler.measure("terrainScreen", () => {
      if (shaders.terrainScreenShader && shaders.terrainScreenBindGroup) {
        const commandEncoder = device.createCommandEncoder({
          label: "Terrain Screen Compute",
        });
        const computePass = commandEncoder.beginComputePass({
          label: "Terrain Screen Compute Pass",
          timestampWrites:
            gpuProfiler?.getComputeTimestampWrites("surface.terrain"),
        });
        shaders.terrainScreenShader.dispatch(
          computePass,
          shaders.terrainScreenBindGroup,
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
      if (
        windResources &&
        shaders.windFieldShader &&
        shaders.windFieldBindGroup
      ) {
        const commandEncoder = device.createCommandEncoder({
          label: "Wind Field Compute",
        });
        const computePass = commandEncoder.beginComputePass({
          label: "Wind Field Compute Pass",
          timestampWrites:
            gpuProfiler?.getComputeTimestampWrites("surface.wind"),
        });
        shaders.windFieldShader.dispatch(
          computePass,
          shaders.windFieldBindGroup,
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
      if (textures.waveFieldTexture && wavePhysicsResources) {
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
            textures.waveFieldTexture,
            gpuProfiler,
          );
          device.queue.submit([commandEncoder.finish()]);
        }
      }
    });

    // === Pass 1.75: Modifier Rasterization ===
    // Rasterize wake/ripple contributions to screen-space texture
    profiler.measure("modifier", () => {
      if (this.modifierRasterizer && textures.modifierTexture) {
        const commandEncoder = device.createCommandEncoder({
          label: "Modifier Rasterization",
        });
        this.modifierRasterizer.render(
          commandEncoder,
          waterResources.modifiersBuffer,
          waterResources.getVisibleModifierCount(),
          worldToTexClipMatrix,
          textures.modifierTexture,
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
      if (this.boatAirShader && textures.boatAirTextureView) {
        const boat = this.game.entities.getById("boat") as Boat | undefined;
        if (boat) {
          this.boatAirShader.render(
            textures.boatAirTextureView,
            worldToTexClipMatrix,
            boat,
          );
        } else {
          // No boat — clear the air texture to "no air anywhere" so the
          // water height compute's substitution is a no-op.
          this.boatAirShader.clear(textures.boatAirTextureView);
        }
      }
    });

    // === Pass 2: Water Height Compute ===
    profiler.measure("waterHeight", () => {
      if (shaders.waterHeightShader && shaders.waterHeightBindGroup) {
        const commandEncoder = device.createCommandEncoder({
          label: "Water Height Compute",
        });
        const computePass = commandEncoder.beginComputePass({
          label: "Water Height Compute Pass",
          timestampWrites:
            gpuProfiler?.getComputeTimestampWrites("surface.water"),
        });
        shaders.waterHeightShader.dispatch(
          computePass,
          shaders.waterHeightBindGroup,
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
      textures.waterHeightView &&
      textures.terrainHeightView
    ) {
      // Wetness texture shares the screen-space layout of water/terrain.
      this.wetnessPipeline.update(
        texClipToWorldMatrix,
        worldToTexClipMatrix,
        textures.waterHeightView,
        textures.terrainHeightView,
        event.dt,
        gpuProfiler,
      );
    }

    // === Pass 3a: Terrain Composite (fragment) ===
    // Renders above-water terrain into the current mainColorTexture pass.
    // greater-equal depth test: boat pixels already at higher z block terrain.
    // Pixels where waterDepth >= 0 are discarded — water filter handles those.
    profiler.measure("terrainComposite", () => {
      const terrainPass = renderer.getCurrentRenderPass();
      if (
        terrainPass &&
        shaders.terrainCompositeShader &&
        shaders.terrainCompositeBindGroup
      ) {
        shaders.terrainCompositeShader.render(
          terrainPass,
          shaders.terrainCompositeBindGroup,
        );
      }
    });

    // Copy depth and color so the water filter can read the frozen scene.
    // Ordering: terrain composite → copyDepthBuffer → copyColorBuffer.
    // copyColorBuffer switches the active render target from mainColorTexture
    // to the swapchain; subsequent draw calls go to the final frame output.
    profiler.measure("copyBuffers", () => {
      renderer.copyDepthBuffer();
      renderer.copyColorBuffer();

      const sceneColorView = renderer.getColorCopyTextureView();
      const sceneDepthView = renderer.getDepthCopyTextureView();
      shaders.rebuildWaterFilterBindGroup(sceneColorView, sceneDepthView);
    });

    // === Pass 3b: Water Filter (fragment) ===
    // Applies physically-based absorption to the frozen scene and writes
    // the final composited pixel to the swapchain. Post-water particles
    // (wake) render on top in their own layers afterward.
    profiler.measure("waterFilter", () => {
      const filterPass = renderer.getCurrentRenderPass();
      if (
        filterPass &&
        shaders.waterFilterShader &&
        shaders.waterFilterBindGroup
      ) {
        shaders.waterFilterShader.render(
          filterPass,
          shaders.waterFilterBindGroup,
        );
      }
    });
  }

  /**
   * Get the screen-space water height texture (output of Pass 2).
   * Returns null if not initialized.
   */
  getWaterHeightTextureView(): GPUTextureView | null {
    return this.textures?.waterHeightView ?? null;
  }

  /**
   * Get the screen-space terrain height texture (output of Pass 1).
   * Returns null if not initialized.
   */
  getTerrainHeightTextureView(): GPUTextureView | null {
    return this.textures?.terrainHeightView ?? null;
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
    this.shaders?.destroy();
    this.terrainTileCache?.destroy();
    this.wetnessPipeline?.destroy();
    this.modifierRasterizer?.destroy();
    this.textures?.destroy();
    this.unsubWaterQuality?.();
    this.unsubWaterQuality = null;
    this.unsubRenderScale?.();
    this.unsubRenderScale = null;
  }
}
