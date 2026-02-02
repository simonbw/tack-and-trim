/**
 * Surface rendering entity.
 *
 * Renders the ocean and terrain as a fullscreen effect using WebGPU.
 * Uses AnalyticalWaterRenderPipeline for wave computation with shadow-based diffraction,
 * TerrainRenderPipeline for terrain height computation,
 * and SurfaceShader for combined rendering with depth-based sand/water blending.
 *
 * Note: Physics tile computation is handled by WaterInfo/TerrainInfo, not here.
 * This entity is purely for rendering.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { Matrix3 } from "../../core/graphics/Matrix3";
import { type UniformInstance } from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { TimeOfDay } from "../time/TimeOfDay";
import { InfluenceFieldManager } from "../world-data/influence/InfluenceFieldManager";
import { TerrainInfo } from "../world-data/terrain/TerrainInfo";
import { WAVE_COMPONENTS } from "../world-data/water/WaterConstants";
import { WaterInfo, type Viewport } from "../world-data/water/WaterInfo";
import {
  AnalyticalWaterRenderPipeline,
  type AnalyticalRenderConfig,
} from "./AnalyticalWaterRenderPipeline";
import { SurfaceShader } from "./SurfaceShader";
import { SurfaceUniforms } from "./SurfaceUniforms";
// Re-export for backwards compatibility
export { SurfaceUniforms } from "./SurfaceUniforms";
import { TerrainRenderPipeline } from "./TerrainRenderPipeline";
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
  private waterPipeline: AnalyticalWaterRenderPipeline | null = null;
  private terrainPipeline: TerrainRenderPipeline;
  private wetnessPipeline: WetnessRenderPipeline;
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

  // Type-safe uniforms instance
  private uniforms: UniformInstance<typeof SurfaceUniforms.fields> | null =
    null;

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
    this.terrainPipeline = null!;
    this.wetnessPipeline = null!;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;
      const renderer = this.game.renderer;

      // Compute texture dimensions from screen size
      const screenWidth = renderer.getWidth();
      const screenHeight = renderer.getHeight();

      const { waterTextureScale, terrainTextureScale, wetnessTextureScale } =
        this.config;
      this.waterTexWidth = Math.ceil(screenWidth * waterTextureScale);
      this.waterTexHeight = Math.ceil(screenHeight * waterTextureScale);
      this.terrainTexWidth = Math.ceil(screenWidth * terrainTextureScale);
      this.terrainTexHeight = Math.ceil(screenHeight * terrainTextureScale);
      this.wetnessTexWidth = Math.ceil(screenWidth * wetnessTextureScale);
      this.wetnessTexHeight = Math.ceil(screenHeight * wetnessTextureScale);

      // Create water render pipeline
      this.waterPipeline = new AnalyticalWaterRenderPipeline(
        this.waterTexWidth,
        this.waterTexHeight,
      );
      await this.waterPipeline.init();

      this.terrainPipeline = new TerrainRenderPipeline(
        this.terrainTexWidth,
        this.terrainTexHeight,
      );
      this.wetnessPipeline = new WetnessRenderPipeline(
        this.wetnessTexWidth,
        this.wetnessTexHeight,
      );

      await this.terrainPipeline.init();

      this.shader = new SurfaceShader();
      await this.shader.init();

      // Create uniform buffer and instance
      this.uniformBuffer = device.createBuffer({
        size: SurfaceUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Surface Uniform Buffer",
      });
      this.uniforms = SurfaceUniforms.create();

      // Set default uniform values
      this.uniforms.set.hasTerrainData(0);
      this.uniforms.set.shallowThreshold(SHALLOW_WATER_THRESHOLD);
      // Set texture dimensions
      this.uniforms.set.waterTexWidth(this.waterTexWidth);
      this.uniforms.set.waterTexHeight(this.waterTexHeight);
      this.uniforms.set.terrainTexWidth(this.terrainTexWidth);
      this.uniforms.set.terrainTexHeight(this.terrainTexHeight);
      this.uniforms.set.wetnessTexWidth(this.wetnessTexWidth);
      this.uniforms.set.wetnessTexHeight(this.wetnessTexHeight);

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
   * Try to configure depth texture and shadow buffers on the water pipeline.
   * Returns true if configured, false if not yet available.
   */
  private tryConfigureWaterPipeline(): boolean {
    if (this.influenceConfigured) return true;
    if (!this.waterPipeline) return false;

    // Get WaterInfo and its WavePhysicsManager
    const waterInfo = WaterInfo.maybeFromGame(this.game);
    if (!waterInfo) return false;

    const wavePhysicsManager = waterInfo.getWavePhysicsManager();
    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) {
      return false;
    }

    // Get depth texture from InfluenceFieldManager
    const influenceManager = InfluenceFieldManager.maybeFromGame(this.game);
    if (!influenceManager) return false;

    const depthTexture = influenceManager.getDepthTexture();
    const depthGridConfig = influenceManager.getDepthGridConfig();

    if (!depthTexture || !depthGridConfig) {
      return false;
    }

    // Create depth sampler
    const device = getWebGPU().device;
    const depthSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Get shadow texture from WavePhysicsManager
    const shadowTextureView = wavePhysicsManager.getShadowTextureView();
    if (!shadowTextureView) {
      console.warn(
        "[SurfaceRenderer] No shadow texture view from WavePhysicsManager",
      );
      return false;
    }

    // Create shadow texture sampler
    const shadowSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const config: AnalyticalRenderConfig = {
      depthTexture,
      depthSampler,
      depthGridConfig,
      shadowTextureView,
      shadowSampler,
      waveSourceDirection: WAVE_COMPONENTS[0][2], // First wave's direction
    };

    this.waterPipeline.setAnalyticalConfig(config);
    this.influenceConfigured = true;
    console.log(
      "[SurfaceRenderer] Analytical water pipeline configured with shadow texture",
    );
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
  private setCameraMatrix(matrix: Matrix3): void {
    if (!this.uniforms) return;
    // mat3x3 setter handles column padding automatically
    this.uniforms.set.cameraMatrix(matrix);
  }

  private setTime(time: number): void {
    if (!this.uniforms) return;
    this.uniforms.set.time(time);
  }

  private setScreenSize(width: number, height: number): void {
    if (!this.uniforms) return;
    this.uniforms.set.screenWidth(width);
    this.uniforms.set.screenHeight(height);
  }

  private setViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!this.uniforms) return;
    this.uniforms.set.viewportLeft(left);
    this.uniforms.set.viewportTop(top);
    this.uniforms.set.viewportWidth(width);
    this.uniforms.set.viewportHeight(height);
  }

  private setHasTerrainData(hasTerrain: boolean): void {
    if (!this.uniforms) return;
    this.uniforms.set.hasTerrainData(hasTerrain ? 1 : 0);
  }

  private setWetnessViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (!this.uniforms) return;
    this.uniforms.set.wetnessViewportLeft(left);
    this.uniforms.set.wetnessViewportTop(top);
    this.uniforms.set.wetnessViewportWidth(width);
    this.uniforms.set.wetnessViewportHeight(height);
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
    if (
      !this.uniformBuffer ||
      !this.sampler ||
      !this.shader ||
      !this.uniforms
    ) {
      return;
    }

    // Use placeholder if no terrain texture
    const effectiveTerrainView =
      terrainTextureView ?? this.placeholderTerrainView!;
    this.setHasTerrainData(!!terrainTextureView);

    // Use placeholder if no wetness texture
    const effectiveWetnessView =
      wetnessTextureView ?? this.placeholderWetnessView!;

    // Upload uniforms
    this.uniforms.uploadTo(this.uniformBuffer);

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

    // Ensure depth texture and shadow buffers are configured
    this.tryConfigureWaterPipeline();

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);
    const gpuProfiler = this.game.renderer.getGpuProfiler();

    // Use TimeOfDay as unified time source
    const timeOfDay = TimeOfDay.maybeFromGame(this.game);
    const currentTime = timeOfDay
      ? timeOfDay.getTimeInSeconds()
      : this.game.elapsedUnpausedTime;

    // Update water render pipeline
    const waterInfo = WaterInfo.fromGame(this.game);

    // Update shadow texture for current viewport (must happen before water update)
    const wavePhysicsManager = waterInfo.getWavePhysicsManager();
    if (wavePhysicsManager?.isInitialized()) {
      wavePhysicsManager.updateShadowTexture(expandedViewport);
    }

    if (this.waterPipeline) {
      this.waterPipeline.update(expandedViewport, waterInfo, gpuProfiler);
    }

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
    const waterTextureView = this.waterPipeline?.getOutputTextureView();
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

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.setCameraMatrix(cameraMatrix);

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
  }

  @on("destroy")
  onDestroy(): void {
    this.waterPipeline?.destroy();
    this.terrainPipeline.destroy();
    this.wetnessPipeline.destroy();
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.placeholderTerrainTexture?.destroy();
    this.placeholderWetnessTexture?.destroy();
    this.bindGroup = null;
  }
}
