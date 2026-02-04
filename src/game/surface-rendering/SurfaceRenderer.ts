/**
 * Surface rendering entity.
 *
 * Renders the ocean and terrain as a unified fullscreen effect using WebGPU.
 * Computes water and terrain heights directly per-pixel in the fragment shader,
 * eliminating the need for intermediate compute textures.
 *
 * Binds directly to resource buffers:
 * - WaterResources: wave data and modifiers
 * - TerrainResources: contour data for height computation
 * - WavePhysicsResources: shadow texture for wave diffraction
 *
 * Note: Wetness is temporarily disabled for Phase 1.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { Matrix3 } from "../../core/graphics/Matrix3";
import { type UniformInstance } from "../../core/graphics/UniformStruct";
import type { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { TimeOfDay } from "../time/TimeOfDay";
import {
  WavePhysicsResources,
  type Viewport,
} from "../wave-physics/WavePhysicsResources";
import { TerrainResources } from "../world/terrain/TerrainResources";
import { WaterResources } from "../world/water/WaterResources";
import {
  GERSTNER_STEEPNESS,
  NUM_WAVES,
  SWELL_WAVE_COUNT,
  WAVE_AMP_MOD_SPATIAL_SCALE,
  WAVE_AMP_MOD_STRENGTH,
  WAVE_AMP_MOD_TIME_SCALE,
  WAVE_COMPONENTS,
} from "../world/water/WaterConstants";
import {
  DEFAULT_DEPTH,
  SPLINE_SUBDIVISIONS,
} from "../world/terrain/TerrainConstants";
import { createUnifiedSurfaceShader } from "./UnifiedSurfaceShader";
import { UnifiedSurfaceUniforms } from "./UnifiedSurfaceUniforms";

// Re-export for backwards compatibility
export { UnifiedSurfaceUniforms as SurfaceUniforms } from "./UnifiedSurfaceUniforms";

// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Surface renderer entity.
 * Handles only rendering - physics tiles are managed by WaterInfo/TerrainResources.
 */
export class SurfaceRenderer extends BaseEntity {
  id = "waterRenderer";
  layer = "water" as const;

  private shader: FullscreenShader | null = null;
  private initialized = false;

  // Track terrain version to avoid redundant bind group recreation
  private lastTerrainVersion = -1;

  // GPU resources for shader uniforms
  private uniformBuffer: GPUBuffer | null = null;
  private shadowSampler: GPUSampler | null = null;

  // Placeholder shadow texture for when wave physics not ready
  private placeholderShadowTexture: GPUTexture | null = null;
  private placeholderShadowView: GPUTextureView | null = null;

  // Placeholder buffers for when resources aren't available
  private placeholderWaveDataBuffer: GPUBuffer | null = null;
  private placeholderModifiersBuffer: GPUBuffer | null = null;
  private placeholderControlPointsBuffer: GPUBuffer | null = null;
  private placeholderContoursBuffer: GPUBuffer | null = null;
  private placeholderChildrenBuffer: GPUBuffer | null = null;

  // Type-safe uniforms instance
  private uniforms: UniformInstance<
    typeof UnifiedSurfaceUniforms.fields
  > | null = null;

  // Cached bind group (recreated when resources change)
  private bindGroup: GPUBindGroup | null = null;

  // Track last resources to detect changes
  private lastShadowView: GPUTextureView | null = null;
  private lastWaveDataBuffer: GPUBuffer | null = null;
  private lastModifiersBuffer: GPUBuffer | null = null;
  private lastControlPointsBuffer: GPUBuffer | null = null;
  private lastContoursBuffer: GPUBuffer | null = null;

  constructor() {
    super();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;

      // Create unified surface shader
      this.shader = createUnifiedSurfaceShader();
      await this.shader.init();

      // Create uniform buffer and instance
      this.uniformBuffer = device.createBuffer({
        size: UnifiedSurfaceUniforms.byteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Unified Surface Uniform Buffer",
      });
      this.uniforms = UnifiedSurfaceUniforms.create();

      // Set default uniform values
      this.uniforms.set.hasTerrainData(0);
      this.uniforms.set.shallowThreshold(SHALLOW_WATER_THRESHOLD);
      this.uniforms.set.numWaves(NUM_WAVES);
      this.uniforms.set.swellWaveCount(SWELL_WAVE_COUNT);
      this.uniforms.set.gerstnerSteepness(GERSTNER_STEEPNESS);
      this.uniforms.set.ampModSpatialScale(WAVE_AMP_MOD_SPATIAL_SCALE);
      this.uniforms.set.ampModTimeScale(WAVE_AMP_MOD_TIME_SCALE);
      this.uniforms.set.ampModStrength(WAVE_AMP_MOD_STRENGTH);
      this.uniforms.set.splineSubdivisions(SPLINE_SUBDIVISIONS);
      this.uniforms.set.defaultDepth(DEFAULT_DEPTH);
      this.uniforms.set.waveSourceDirection(WAVE_COMPONENTS[0][2]);

      // Create shadow sampler
      this.shadowSampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      // Create placeholder shadow texture (rg16float format, no shadows = full energy)
      this.placeholderShadowTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rg16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: "Placeholder Shadow Texture",
      });
      this.placeholderShadowView = this.placeholderShadowTexture.createView();

      // Write full energy (1.0, 1.0) to placeholder
      const shadowData = new Uint16Array([
        0x3c00,
        0x3c00, // 1.0 in float16 for R and G channels
      ]);
      device.queue.writeTexture(
        { texture: this.placeholderShadowTexture },
        shadowData,
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );

      // Create placeholder buffers for when resources aren't available
      this.placeholderWaveDataBuffer = device.createBuffer({
        size: 64, // Minimum size for storage buffer
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Wave Data Buffer",
      });

      this.placeholderModifiersBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.STORAGE,
        label: "Placeholder Modifiers Buffer",
      });

      this.placeholderControlPointsBuffer = device.createBuffer({
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
    this.uniforms.set.cameraMatrix(matrix);
  }

  /**
   * Update uniforms for the current frame.
   */
  private updateUniforms(
    viewport: Viewport,
    currentTime: number,
    waterResources: WaterResources | undefined,
    terrainResources: TerrainResources | undefined,
  ): void {
    if (!this.uniforms) return;

    const renderer = this.game.getRenderer();

    // Screen and viewport
    this.uniforms.set.screenWidth(renderer.getWidth());
    this.uniforms.set.screenHeight(renderer.getHeight());
    this.uniforms.set.viewportLeft(viewport.left);
    this.uniforms.set.viewportTop(viewport.top);
    this.uniforms.set.viewportWidth(viewport.width);
    this.uniforms.set.viewportHeight(viewport.height);
    this.uniforms.set.time(currentTime);

    // Water parameters
    if (waterResources) {
      this.uniforms.set.tideHeight(waterResources.getTideHeight());
      this.uniforms.set.modifierCount(waterResources.getModifierCount());
      this.uniforms.set.waveSourceDirection(
        waterResources.getAnalyticalConfig().waveSourceDirection,
      );
    } else {
      this.uniforms.set.tideHeight(0);
      this.uniforms.set.modifierCount(0);
    }

    // Terrain parameters
    if (terrainResources) {
      this.uniforms.set.hasTerrainData(1);
      this.uniforms.set.contourCount(terrainResources.getContourCount());
    } else {
      this.uniforms.set.hasTerrainData(0);
      this.uniforms.set.contourCount(0);
    }
  }

  /**
   * Recreate bind group if resources have changed.
   */
  private ensureBindGroup(
    waterResources: WaterResources | undefined,
    terrainResources: TerrainResources | undefined,
    shadowTextureView: GPUTextureView,
  ): void {
    if (!this.shader || !this.uniformBuffer || !this.shadowSampler) return;

    // Get actual buffers or use placeholders
    const waveDataBuffer =
      waterResources?.waveDataBuffer ?? this.placeholderWaveDataBuffer!;
    const modifiersBuffer =
      waterResources?.modifiersBuffer ?? this.placeholderModifiersBuffer!;
    const controlPointsBuffer =
      terrainResources?.controlPointsBuffer ??
      this.placeholderControlPointsBuffer!;
    const contoursBuffer =
      terrainResources?.contourBuffer ?? this.placeholderContoursBuffer!;
    const childrenBuffer =
      terrainResources?.childrenBuffer ?? this.placeholderChildrenBuffer!;

    // Check if we need to recreate the bind group
    const terrainVersion = terrainResources?.getVersion() ?? -1;
    const needsRebuild =
      !this.bindGroup ||
      this.lastShadowView !== shadowTextureView ||
      this.lastWaveDataBuffer !== waveDataBuffer ||
      this.lastModifiersBuffer !== modifiersBuffer ||
      this.lastControlPointsBuffer !== controlPointsBuffer ||
      this.lastContoursBuffer !== contoursBuffer ||
      this.lastTerrainVersion !== terrainVersion;

    if (!needsRebuild) return;

    // Create new bind group
    this.bindGroup = this.shader.createBindGroup({
      uniforms: { buffer: this.uniformBuffer },
      waveData: { buffer: waveDataBuffer },
      modifiers: { buffer: modifiersBuffer },
      controlPoints: { buffer: controlPointsBuffer },
      contours: { buffer: contoursBuffer },
      children: { buffer: childrenBuffer },
      shadowTexture: shadowTextureView,
      shadowSampler: this.shadowSampler,
    });

    // Update tracking
    this.lastShadowView = shadowTextureView;
    this.lastWaveDataBuffer = waveDataBuffer;
    this.lastModifiersBuffer = modifiersBuffer;
    this.lastControlPointsBuffer = controlPointsBuffer;
    this.lastContoursBuffer = contoursBuffer;
    this.lastTerrainVersion = terrainVersion;
  }

  @on("render")
  onRender(_event: { dt: number; draw: Draw }) {
    if (!this.initialized || !this.shader || !this.uniforms) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
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

    // Update shadow texture for current viewport (must happen before rendering)
    // Use GPU profiling for shadow compute timing
    const gpuProfiler = renderer.getGpuProfiler();
    if (wavePhysicsResources?.isInitialized()) {
      wavePhysicsResources.updateShadowTexture(
        expandedViewport,
        gpuProfiler?.getTimestampWrites("shadowCompute"),
      );
    }

    // Get shadow texture view (use placeholder if not available)
    const shadowTextureView =
      wavePhysicsResources?.getShadowTextureView() ??
      this.placeholderShadowView!;

    // Update uniforms
    this.updateUniforms(
      expandedViewport,
      currentTime,
      waterResources,
      terrainResources,
    );

    // Get inverse camera matrix for screen-to-world transform
    const cameraMatrix = camera.getMatrix().clone().invert();
    this.setCameraMatrix(cameraMatrix);

    // Upload uniforms
    this.uniforms.uploadTo(this.uniformBuffer!);

    // Ensure bind group is up to date
    this.ensureBindGroup(waterResources, terrainResources, shadowTextureView);

    // Use the main renderer's render pass
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass || !this.bindGroup) return;

    // Render the unified surface shader
    this.shader.render(renderPass, this.bindGroup);
  }

  @on("destroy")
  onDestroy(): void {
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.placeholderShadowTexture?.destroy();
    this.placeholderWaveDataBuffer?.destroy();
    this.placeholderModifiersBuffer?.destroy();
    this.placeholderControlPointsBuffer?.destroy();
    this.placeholderContoursBuffer?.destroy();
    this.placeholderChildrenBuffer?.destroy();
    this.bindGroup = null;
  }
}
