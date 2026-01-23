/**
 * Editor surface rendering entity.
 *
 * Simplified version of SurfaceRenderer for the terrain editor.
 * Renders water and terrain without influence fields or wetness tracking.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { getWebGPU } from "../core/graphics/webgpu/WebGPUDevice";
import { TerrainInfo } from "../game/world-data/terrain/TerrainInfo";
import { WaterInfo, type Viewport } from "../game/world-data/water/WaterInfo";
import { SurfaceShader } from "../game/surface-rendering/SurfaceShader";
import { TerrainRenderPipeline } from "../game/surface-rendering/TerrainRenderPipeline";
import { WaterRenderPipeline } from "../game/surface-rendering/WaterRenderPipeline";

// Texture sizes (smaller than main game for editor)
const WATER_TEXTURE_SIZE = 256;
const TERRAIN_TEXTURE_SIZE = 256;

// Margin for render viewport expansion
const RENDER_VIEWPORT_MARGIN = 0.1;

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Editor surface renderer entity.
 * Renders water and terrain without influence fields.
 */
export class EditorSurfaceRenderer extends BaseEntity {
  layer = "water" as const;

  private shader: SurfaceShader | null = null;
  private waterPipeline: WaterRenderPipeline;
  private terrainPipeline: TerrainRenderPipeline;
  private initialized = false;

  // Track terrain version to avoid redundant GPU buffer updates
  private lastTerrainVersion = -1;

  // GPU resources for shader uniforms
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private placeholderTerrainTexture: GPUTexture | null = null;
  private placeholderTerrainView: GPUTextureView | null = null;
  private placeholderWetnessTexture: GPUTexture | null = null;
  private placeholderWetnessView: GPUTextureView | null = null;

  // Uniform data array (same layout as SurfaceRenderer)
  private uniformData = new Float32Array(28);

  // Cached bind group
  private bindGroup: GPUBindGroup | null = null;
  private lastWaterTexture: GPUTextureView | null = null;
  private lastTerrainTexture: GPUTextureView | null = null;

  constructor() {
    super();
    this.waterPipeline = new WaterRenderPipeline(WATER_TEXTURE_SIZE);
    this.terrainPipeline = new TerrainRenderPipeline(TERRAIN_TEXTURE_SIZE);

    // Default uniform values
    this.uniformData[21] = 0; // hasTerrainData
    this.uniformData[22] = SHALLOW_WATER_THRESHOLD;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized || !this.game) return;

    try {
      const device = getWebGPU().device;

      await this.waterPipeline.init();
      await this.terrainPipeline.init();

      this.shader = new SurfaceShader();
      await this.shader.init();

      // Create uniform buffer
      this.uniformBuffer = device.createBuffer({
        size: 112, // 28 floats * 4 bytes
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Editor Surface Uniform Buffer",
      });

      // Create sampler
      this.sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      // Create placeholder terrain texture (1x1 deep water)
      this.placeholderTerrainTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: "Editor Placeholder Terrain Texture",
      });
      this.placeholderTerrainView = this.placeholderTerrainTexture.createView();

      device.queue.writeTexture(
        { texture: this.placeholderTerrainTexture },
        new Float32Array([-50, 0, 0, 1]),
        { bytesPerRow: 16 },
        { width: 1, height: 1 },
      );

      // Create placeholder wetness texture (1x1, dry)
      this.placeholderWetnessTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "r32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label: "Editor Placeholder Wetness Texture",
      });
      this.placeholderWetnessView = this.placeholderWetnessTexture.createView();

      device.queue.writeTexture(
        { texture: this.placeholderWetnessTexture },
        new Float32Array([0]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize EditorSurfaceRenderer:", error);
    }
  }

  @on("add")
  onAdd() {
    this.ensureInitialized();
  }

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

  private setCameraMatrix(matrix: Float32Array): void {
    // Pack mat3x3 with 16-byte alignment per column
    this.uniformData[0] = matrix[0];
    this.uniformData[1] = matrix[1];
    this.uniformData[2] = matrix[2];
    this.uniformData[3] = 0;

    this.uniformData[4] = matrix[3];
    this.uniformData[5] = matrix[4];
    this.uniformData[6] = matrix[5];
    this.uniformData[7] = 0;

    this.uniformData[8] = matrix[6];
    this.uniformData[9] = matrix[7];
    this.uniformData[10] = matrix[8];
    this.uniformData[11] = 0;
  }

  private setTime(time: number): void {
    this.uniformData[12] = time;
  }

  private setRenderMode(mode: number): void {
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
    this.uniformData[24] = left;
    this.uniformData[25] = top;
    this.uniformData[26] = width;
    this.uniformData[27] = height;
  }

  private renderSurface(
    renderPass: GPURenderPassEncoder,
    waterTextureView: GPUTextureView,
    terrainTextureView: GPUTextureView | null,
  ): void {
    if (!this.uniformBuffer || !this.sampler || !this.shader) {
      return;
    }

    const device = getWebGPU().device;

    const effectiveTerrainView =
      terrainTextureView ?? this.placeholderTerrainView!;
    this.setHasTerrainData(!!terrainTextureView);

    const effectiveWetnessView = this.placeholderWetnessView!;

    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);

    // Recreate bind group if textures changed
    if (
      !this.bindGroup ||
      this.lastWaterTexture !== waterTextureView ||
      this.lastTerrainTexture !== effectiveTerrainView
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
    }

    this.shader.render(renderPass, this.bindGroup);
  }

  @on("render")
  onRender() {
    if (!this.initialized || !this.shader) return;

    const camera = this.game.camera;
    const renderer = this.game.getRenderer();
    const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN);
    const currentTime = this.game.elapsedUnpausedTime;

    // Update water pipeline (uses fallback influence textures)
    const waterInfo = WaterInfo.maybeFromGame(this.game);
    if (waterInfo) {
      this.waterPipeline.update(expandedViewport, waterInfo, null);
    }

    // Update terrain pipeline
    const terrainInfo = TerrainInfo.maybeFromGame(this.game);
    let terrainTextureView: GPUTextureView | null = null;

    if (terrainInfo) {
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

      if (this.terrainPipeline.hasTerrainData()) {
        this.terrainPipeline.update(
          {
            left: expandedViewport.left,
            top: expandedViewport.top,
            width: expandedViewport.width,
            height: expandedViewport.height,
          },
          currentTime,
          null,
        );

        terrainTextureView = this.terrainPipeline.getOutputTextureView();
      }
    }

    // Get water texture view
    const waterTextureView = this.waterPipeline.getOutputTextureView();
    if (!waterTextureView) return;

    // Update shader uniforms
    this.setTime(this.game.elapsedTime);
    this.setScreenSize(renderer.getWidth(), renderer.getHeight());
    this.setViewportBounds(
      expandedViewport.left,
      expandedViewport.top,
      expandedViewport.width,
      expandedViewport.height,
    );
    // Use viewport as wetness viewport (placeholder texture ignores it)
    this.setWetnessViewportBounds(
      expandedViewport.left,
      expandedViewport.top,
      expandedViewport.width,
      expandedViewport.height,
    );
    this.setRenderMode(0); // Normal rendering

    const cameraMatrix = camera.getMatrix().clone().invert();
    this.setCameraMatrix(cameraMatrix.toArray());

    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    this.renderSurface(renderPass, waterTextureView, terrainTextureView);
  }

  @on("destroy")
  onDestroy(): void {
    this.waterPipeline.destroy();
    this.terrainPipeline.destroy();
    this.shader?.destroy();
    this.uniformBuffer?.destroy();
    this.placeholderTerrainTexture?.destroy();
    this.placeholderWetnessTexture?.destroy();
    this.bindGroup = null;
  }
}
