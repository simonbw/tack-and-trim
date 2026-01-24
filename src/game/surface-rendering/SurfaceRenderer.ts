/**
 * Surface rendering entity.
 *
 * Renders the ocean and terrain as a fullscreen effect using WebGPU.
 * Uses WaterRenderPipeline for unified wave/modifier computation,
 * TerrainRenderPipeline for terrain height computation,
 * and SurfaceShader for combined rendering with depth-based sand/water blending.
 *
 * Note: Physics tile computation is handled by WaterInfo/TerrainInfo, not here.
 * This entity is purely for rendering.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { TimeOfDay } from "../time/TimeOfDay";
import { InfluenceFieldManager } from "../world-data/influence/InfluenceFieldManager";
import { TerrainInfo } from "../world-data/terrain/TerrainInfo";
import { getTerrainHeightColor } from "../world-data/terrain/TerrainColors";
import { WAVE_COMPONENTS } from "../world-data/water/WaterConstants";
import { WaterInfo, type Viewport } from "../world-data/water/WaterInfo";
import { SurfaceShader } from "./SurfaceShader";
import { TerrainRenderPipeline } from "./TerrainRenderPipeline";
import {
  WaterRenderPipeline,
  type RenderInfluenceConfig,
} from "./WaterRenderPipeline";
import { WetnessRenderPipeline } from "./WetnessRenderPipeline";

/** Default texture resolution scale relative to screen (0.5 = half resolution) */
export const DEFAULT_TEXTURE_SCALE = 0.5;

/**
 * Configuration options for SurfaceRenderer.
 */
export interface SurfaceRendererConfig {
  /** Texture resolution scale relative to screen (default: 0.5) */
  textureScale?: number;
  /** Optional separate scale for water texture */
  waterTextureScale?: number;
  /** Optional separate scale for terrain texture */
  terrainTextureScale?: number;
  /** Optional separate scale for wetness texture */
  wetnessTextureScale?: number;
}

// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

// Margin for wetness viewport (larger to handle camera movement)
const WETNESS_VIEWPORT_MARGIN = 0.5;

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Surface renderer entity.
 * Handles only rendering - physics tiles are managed by WaterInfo/TerrainInfo.
 */
export class SurfaceRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private shader: SurfaceShader | null = null;
  private renderPipeline: WaterRenderPipeline;
  private terrainPipeline: TerrainRenderPipeline;
  private wetnessPipeline: WetnessRenderPipeline;
  private renderMode = 0;
  private initialized = false;

  // Track terrain version to avoid redundant GPU buffer updates
  private lastTerrainVersion = -1;

  // GPU resources for shader uniforms
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private placeholderTerrainTexture: GPUTexture | null = null;
  private placeholderTerrainView: GPUTextureView | null = null;

  // Computed texture dimensions
  private waterTexWidth = 0;
  private waterTexHeight = 0;
  private terrainTexWidth = 0;
  private terrainTexHeight = 0;
  private wetnessTexWidth = 0;
  private wetnessTexHeight = 0;

  // Uniform data array
  // Layout (144 bytes total for WebGPU 16-byte alignment):
  // Indices 0-11:  mat3x3 (3x vec4 = 48 bytes, padded columns)
  // Index 12:      time (f32)
  // Index 13:      renderMode (i32 as f32)
  // Index 14-15:   screenWidth, screenHeight (f32)
  // Index 16-19:   viewport bounds (left, top, width, height) (f32)
  // Index 20:      colorNoiseStrength (f32)
  // Index 21:      hasTerrainData (i32 as f32)
  // Index 22:      shallowThreshold (f32)
  // Index 23-24:   waterTexWidth, waterTexHeight (f32)
  // Index 25-26:   terrainTexWidth, terrainTexHeight (f32)
  // Index 27-28:   wetnessTexWidth, wetnessTexHeight (f32)
  // Index 29-30:   padding
  // Index 31-34:   wetness viewport bounds (left, top, width, height) (f32)
  private uniformData = new Float32Array(36);

  // Cached bind group (recreated when texture changes)
  private bindGroup: GPUBindGroup | null = null;
  private lastWaterTexture: GPUTextureView | null = null;
  private lastTerrainTexture: GPUTextureView | null = null;
  private lastWetnessTexture: GPUTextureView | null = null;

  // Placeholder wetness texture for when wetness pipeline not ready
  private placeholderWetnessTexture: GPUTexture | null = null;
  private placeholderWetnessView: GPUTextureView | null = null;

  // Track if influence textures have been configured
  private influenceConfigured = false;

  // Configuration
  private config: Required<SurfaceRendererConfig>;

  constructor(config?: SurfaceRendererConfig) {
    super();

    // Apply defaults to config
    const defaultScale = config?.textureScale ?? DEFAULT_TEXTURE_SCALE;
    this.config = {
      textureScale: defaultScale,
      waterTextureScale: config?.waterTextureScale ?? defaultScale,
      terrainTextureScale: config?.terrainTextureScale ?? defaultScale,
      wetnessTextureScale: config?.wetnessTextureScale ?? defaultScale,
    };

    // Pipelines will be created in ensureInitialized after we have screen dimensions
    this.renderPipeline = null!;
    this.terrainPipeline = null!;
    this.wetnessPipeline = null!;

    // Default uniform values (indices will be updated after uniform layout is finalized)
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;
      const renderer = this.game.renderer;

      // Compute texture dimensions from screen size
      const screenWidth = renderer.getWidth();
      const screenHeight = renderer.getHeight();

      this.waterTexWidth = Math.ceil(
        screenWidth * this.config.waterTextureScale,
      );
      this.waterTexHeight = Math.ceil(
        screenHeight * this.config.waterTextureScale,
      );
      this.terrainTexWidth = Math.ceil(
        screenWidth * this.config.terrainTextureScale,
      );
      this.terrainTexHeight = Math.ceil(
        screenHeight * this.config.terrainTextureScale,
      );
      this.wetnessTexWidth = Math.ceil(
        screenWidth * this.config.wetnessTextureScale,
      );
      this.wetnessTexHeight = Math.ceil(
        screenHeight * this.config.wetnessTextureScale,
      );

      // Create pipelines with computed dimensions
      this.renderPipeline = new WaterRenderPipeline(
        this.waterTexWidth,
        this.waterTexHeight,
      );
      this.terrainPipeline = new TerrainRenderPipeline(
        this.terrainTexWidth,
        this.terrainTexHeight,
      );
      this.wetnessPipeline = new WetnessRenderPipeline(
        this.wetnessTexWidth,
        this.wetnessTexHeight,
      );

      await this.renderPipeline.init();
      await this.terrainPipeline.init();

      this.shader = new SurfaceShader();
      await this.shader.init();

      // Create uniform buffer
      this.uniformBuffer = device.createBuffer({
        size: 144, // 36 floats * 4 bytes
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Surface Uniform Buffer",
      });

      // Set default uniform values
      this.uniformData[21] = 0; // hasTerrainData
      this.uniformData[22] = SHALLOW_WATER_THRESHOLD; // shallowThreshold
      // Set texture dimensions
      this.uniformData[23] = this.waterTexWidth;
      this.uniformData[24] = this.waterTexHeight;
      this.uniformData[25] = this.terrainTexWidth;
      this.uniformData[26] = this.terrainTexHeight;
      this.uniformData[27] = this.wetnessTexWidth;
      this.uniformData[28] = this.wetnessTexHeight;

      // Create sampler
      this.sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      // Create placeholder terrain texture (1x1 deep water = no terrain)
      this.placeholderTerrainTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: "Placeholder Terrain Texture",
      });
      this.placeholderTerrainView = this.placeholderTerrainTexture.createView();

      // Write deep water value (-50) to placeholder
      device.queue.writeTexture(
        { texture: this.placeholderTerrainTexture },
        new Float32Array([-50, 0, 0, 1]),
        { bytesPerRow: 16 },
        { width: 1, height: 1 },
      );

      // Create placeholder wetness texture (1x1, dry = 0)
      this.placeholderWetnessTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "r32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: "Placeholder Wetness Texture",
      });
      this.placeholderWetnessView = this.placeholderWetnessTexture.createView();

      // Write dry value (0) to placeholder
      device.queue.writeTexture(
        { texture: this.placeholderWetnessTexture },
        new Float32Array([0]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );

      // Initialize wetness pipeline
      await this.wetnessPipeline.init();

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize SurfaceRenderer:", error);
    }
  }

  @on("add")
  onAdd() {
    this.ensureInitialized();
  }

  @on("influenceFieldsReady")
  onInfluenceFieldsReady() {
    // Reset flag so textures get reconfigured with new influence data
    this.influenceConfigured = false;
  }

  /**
   * Try to configure influence textures on the render pipeline.
   * Returns true if configured, false if not yet available.
   */
  private tryConfigureInfluenceTextures(): boolean {
    if (this.influenceConfigured) return true;

    const influenceManager = InfluenceFieldManager.maybeFromGame(this.game);
    if (!influenceManager) return false;

    const swellTexture = influenceManager.getSwellTexture();
    const fetchTexture = influenceManager.getFetchTexture();
    const depthTexture = influenceManager.getDepthTexture();
    const influenceSampler = influenceManager.getInfluenceSampler();
    const swellGridConfig = influenceManager.getSwellGridConfig();
    const fetchGridConfig = influenceManager.getFetchGridConfig();
    const depthGridConfig = influenceManager.getDepthGridConfig();

    if (
      !swellTexture ||
      !fetchTexture ||
      !depthTexture ||
      !influenceSampler ||
      !swellGridConfig ||
      !fetchGridConfig ||
      !depthGridConfig
    ) {
      return false;
    }

    const config: RenderInfluenceConfig = {
      swellTexture,
      fetchTexture,
      depthTexture,
      influenceSampler,
      swellGridConfig,
      fetchGridConfig,
      depthGridConfig,
      waveSourceDirection: WAVE_COMPONENTS[0][2], // First wave's direction
    };

    this.renderPipeline.setInfluenceTextures(config);
    this.influenceConfigured = true;
    return true;
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
   * Set the camera inverse matrix (screen to world).
   */
  private setCameraMatrix(matrix: Float32Array): void {
    // Pack mat3x3 with 16-byte alignment per column
    this.uniformData[0] = matrix[0];
    this.uniformData[1] = matrix[1];
    this.uniformData[2] = matrix[2];
    this.uniformData[3] = 0; // padding

    this.uniformData[4] = matrix[3];
    this.uniformData[5] = matrix[4];
    this.uniformData[6] = matrix[5];
    this.uniformData[7] = 0; // padding

    this.uniformData[8] = matrix[6];
    this.uniformData[9] = matrix[7];
    this.uniformData[10] = matrix[8];
    this.uniformData[11] = 0; // padding
  }

  private setTime(time: number): void {
    this.uniformData[12] = time;
  }

  private setRenderModeUniform(mode: number): void {
    this.uniformData[13] = mode;
  }

  private setScreenSize(width: number, height: number): void {
    this.uniformData[14] = width;
    this.uniformData[15] = height;
  }

  private setViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    this.uniformData[16] = left;
    this.uniformData[17] = top;
    this.uniformData[18] = width;
    this.uniformData[19] = height;
  }

  private setHasTerrainData(hasTerrain: boolean): void {
    this.uniformData[21] = hasTerrain ? 1 : 0;
  }

  private setWetnessViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    // Indices 31-34 for wetness viewport (after texture dimensions at 23-28, padding at 29-30)
    this.uniformData[31] = left;
    this.uniformData[32] = top;
    this.uniformData[33] = width;
    this.uniformData[34] = height;
  }

  /**
   * Render the surface using the shader.
   */
  private renderSurface(
    renderPass: GPURenderPassEncoder,
    waterTextureView: GPUTextureView,
    terrainTextureView: GPUTextureView | null,
    wetnessTextureView: GPUTextureView | null,
  ): void {
    if (!this.uniformBuffer || !this.sampler || !this.shader) {
      return;
    }

    const device = getWebGPU().device;

    // Use placeholder if no terrain texture
    const effectiveTerrainView =
      terrainTextureView ?? this.placeholderTerrainView!;
    this.setHasTerrainData(!!terrainTextureView);

    // Use placeholder if no wetness texture
    const effectiveWetnessView =
      wetnessTextureView ?? this.placeholderWetnessView!;

    // Upload uniforms
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);

    // Recreate bind group if textures changed
    if (
      !this.bindGroup ||
      this.lastWaterTexture !== waterTextureView ||
      this.lastTerrainTexture !== effectiveTerrainView ||
      this.lastWetnessTexture !== effectiveWetnessView
    ) {
      this.bindGroup = this.shader.createBindGroup({
        uniforms: { buffer: this.uniformBuffer },
        waterSampler: this.sampler,
        waterDataTexture: waterTextureView,
        terrainDataTexture: effectiveTerrainView,
        wetnessTexture: effectiveWetnessView,
      });
      this.lastWaterTexture = waterTextureView;
      this.lastTerrainTexture = effectiveTerrainView;
      this.lastWetnessTexture = effectiveWetnessView;
    }

    // Render using shader
    this.shader.render(renderPass, this.bindGroup);
  }

  @on("render")
  onRender({ dt, draw }: { dt: number; draw: Draw }) {
    if (!this.initialized || !this.shader) return;

    // Ensure influence textures are configured (needed for per-pixel wave sampling)
    this.tryConfigureInfluenceTextures();

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);
    const gpuProfiler = this.game.renderer.getGpuProfiler();

    // Use TimeOfDay as unified time source
    const timeOfDay = TimeOfDay.maybeFromGame(this.game);
    const currentTime = timeOfDay
      ? timeOfDay.getTimeInSeconds()
      : this.game.elapsedUnpausedTime;

    // Update water render pipeline (runs unified GPU compute)
    const waterInfo = WaterInfo.fromGame(this.game);
    this.renderPipeline.update(expandedViewport, waterInfo, gpuProfiler);

    // Update terrain render pipeline if terrain exists
    const terrainInfo = TerrainInfo.maybeFromGame(this.game);
    let terrainTextureView: GPUTextureView | null = null;

    if (terrainInfo) {
      // Sync terrain definition with render pipeline ONLY when it changes
      const currentTerrainVersion = terrainInfo.getVersion();
      if (currentTerrainVersion !== this.lastTerrainVersion) {
        const contours = terrainInfo.getContours();
        if (contours.length > 0) {
          this.terrainPipeline.setTerrainDefinition({
            contours: [...contours],
          });
        }
        this.lastTerrainVersion = currentTerrainVersion;
      }

      // Update terrain compute (viewport params only - terrain data already synced)
      if (this.terrainPipeline.hasTerrainData()) {
        this.terrainPipeline.update(
          {
            left: expandedViewport.left,
            top: expandedViewport.top,
            width: expandedViewport.width,
            height: expandedViewport.height,
          },
          currentTime,
          gpuProfiler,
          "terrainCompute",
        );

        terrainTextureView = this.terrainPipeline.getOutputTextureView();
      }
    }

    // Get water texture view
    const waterTextureView = this.renderPipeline.getOutputTextureView();
    if (!waterTextureView) return;

    // Update wetness pipeline (needs water and terrain textures)
    let wetnessTextureView: GPUTextureView | null = null;
    const wetnessViewport = this.getExpandedViewport(WETNESS_VIEWPORT_MARGIN);
    if (terrainTextureView) {
      this.wetnessPipeline.update(
        wetnessViewport,
        expandedViewport, // render viewport for sampling water/terrain
        waterTextureView,
        terrainTextureView,
        dt,
        gpuProfiler,
        "wetnessCompute",
      );
      wetnessTextureView = this.wetnessPipeline.getOutputTextureView();
    }

    // Get snapped wetness viewport for correct UV mapping in shader
    // (The pipeline snaps to texel grid to prevent blur from sub-pixel sampling)
    const snappedWetnessViewport =
      this.wetnessPipeline.getSnappedViewport() ?? wetnessViewport;

    // Update shader uniforms
    this.setTime(this.game.elapsedTime);
    this.setScreenSize(renderer.getWidth(), renderer.getHeight());
    this.setViewportBounds(
      expandedViewport.left,
      expandedViewport.top,
      expandedViewport.width,
      expandedViewport.height,
    );
    this.setWetnessViewportBounds(
      snappedWetnessViewport.left,
      snappedWetnessViewport.top,
      snappedWetnessViewport.width,
      snappedWetnessViewport.height,
    );
    this.setRenderModeUniform(this.renderMode);

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.setCameraMatrix(cameraMatrix.toArray());

    // Use the main renderer's render pass
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Render surface with optional terrain and wetness
    this.renderSurface(
      renderPass,
      waterTextureView,
      terrainTextureView,
      wetnessTextureView,
    );

    // Draw terrain contour lines in debug mode
    if (this.renderMode === 1 && terrainInfo) {
      const contours = terrainInfo.getContours();
      for (const contour of contours) {
        // First pass: white outline for visibility
        draw.strokeSmoothPolygon([...contour.controlPoints], {
          color: 0xffffff,
          width: contour.height === 0 ? 3 : 2,
          alpha: 0.9,
        });

        // Second pass: thinner colored line on top using shared color function
        // Sea level (height 0) uses black for contrast on white outline
        const color =
          contour.height === 0
            ? 0x000000
            : getTerrainHeightColor(contour.height);

        draw.strokeSmoothPolygon([...contour.controlPoints], {
          color,
          width: contour.height === 0 ? 1.5 : 1,
          alpha: 1,
        });
      }
    }
  }

  setRenderMode(mode: number): void {
    this.renderMode = mode;
  }

  getRenderMode(): number {
    return this.renderMode;
  }

  @on("destroy")
  onDestroy(): void {
    this.renderPipeline.destroy();
    this.terrainPipeline.destroy();
    this.wetnessPipeline.destroy();
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.placeholderTerrainTexture?.destroy();
    this.placeholderWetnessTexture?.destroy();
    this.bindGroup = null;
  }
}
