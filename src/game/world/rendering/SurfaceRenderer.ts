import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Camera2d } from "../../../core/graphics/Camera2d";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WebGPUTexture } from "../../../core/graphics/webgpu/WebGPUTextureManager";
import { TerrainSystem } from "../terrain/TerrainSystem";
import { WaterSystem } from "../water/WaterSystem";
import { CompositePass } from "./CompositePass";
import { TerrainRenderPass } from "./TerrainRenderPass";
import { WaterRenderPass } from "./WaterRenderPass";
import { WetnessPass } from "./WetnessPass";

/**
 * Render rectangle in world space
 */
export interface RenderRect {
  /** Left edge in world space */
  x: number;
  /** Top edge in world space */
  y: number;
  /** Width in world space */
  width: number;
  /** Height in world space */
  height: number;
  /** Texel scale (world units per texel) */
  texelScale: number;
}

/**
 * Main surface rendering entity that orchestrates the 4-pass rendering pipeline:
 * 1. TerrainRenderPass: Sample terrain VirtualTexture → terrainTexture (height, material)
 * 2. WaterRenderPass: Evaluate Gerstner waves → waterTexture (height, normal.xy, foam)
 * 3. WetnessPass: Reprojection and decay → wetnessTexture (ping-pong)
 * 4. CompositePass: Blend everything with lighting → screen
 *
 * Runs on "waterShader" layer (no parallax) between "water" and "underhull" layers.
 */
export class SurfaceRenderer extends BaseEntity {
  readonly id = "surfaceRenderer";
  readonly layer = "waterShader";

  // Render passes
  private terrainPass: TerrainRenderPass | null = null;
  private waterPass: WaterRenderPass | null = null;
  private wetnessPass: WetnessPass | null = null;
  private compositePass: CompositePass | null = null;

  // Render targets
  private terrainTexture: GPUTexture | null = null;
  private waterTexture: GPUTexture | null = null;
  private wetnessTextureA: GPUTexture | null = null;
  private wetnessTextureB: GPUTexture | null = null;
  private compositeTexture: WebGPUTexture | null = null; // Offscreen target for draw.image

  // Wetness ping-pong state
  private wetnessPingPongIndex = 0; // 0 or 1

  // Render rect tracking
  private currentRect: RenderRect | null = null;
  private previousRect: RenderRect | null = null;

  // Screen size tracking for resize detection
  private lastScreenWidth = 0;
  private lastScreenHeight = 0;

  // Initialization state
  private isInitialized = false;

  /**
   * Initialize GPU resources and render passes
   */
  @on("add")
  async onAdd(): Promise<void> {
    try {
      // Create render passes
      this.terrainPass = new TerrainRenderPass();
      await this.terrainPass.init();

      this.waterPass = new WaterRenderPass();
      await this.waterPass.init();

      this.wetnessPass = new WetnessPass();
      await this.wetnessPass.init();

      this.compositePass = new CompositePass();
      await this.compositePass.init();

      this.isInitialized = true;
      console.log("[SurfaceRenderer] Initialized successfully");
    } catch (error) {
      console.error("[SurfaceRenderer] Failed to initialize:", error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Blit the composite texture to screen during layer rendering
   */
  @on("render")
  onRender({ draw, camera, layer }: GameEventMap["render"]): void {
    this.renderToTexture(camera);
    if (!this.compositeTexture || !this.currentRect) {
      console.warn(
        "[SurfaceRenderer] Skipping - no compositeTexture or currentRect",
      );
      return;
    }

    // Draw the composite texture as a fullscreen image covering the render rect
    draw.image(this.compositeTexture, this.currentRect.x, this.currentRect.y, {
      anchorX: 0,
      anchorY: 1,
      scaleX: this.currentRect.width / this.compositeTexture.width,
      scaleY: -this.currentRect.height / this.compositeTexture.height,
    });
  }

  /**
   * Render compute passes to offscreen textures
   */
  renderToTexture(camera: Camera2d): void {
    if (!this.isInitialized) {
      console.warn("[SurfaceRenderer] afterPhysics called but not initialized");
      return;
    }

    if (!camera) {
      console.warn("[SurfaceRenderer] No camera in render event");
      return;
    }

    const device = getWebGPU().device;
    const screenWidth = this.game.renderer.getWidth();
    const screenHeight = this.game.renderer.getHeight();

    // Check for screen resize
    const resized =
      screenWidth !== this.lastScreenWidth ||
      screenHeight !== this.lastScreenHeight;

    if (resized) {
      this.lastScreenWidth = screenWidth;
      this.lastScreenHeight = screenHeight;
      this.deallocateTextures();
    }

    // Compute render rect from camera
    this.previousRect = this.currentRect;
    this.currentRect = this.computeRenderRect(
      camera,
      screenWidth,
      screenHeight,
    );

    // Allocate textures if needed
    if (!this.terrainTexture || resized) {
      this.allocateTextures(screenWidth, screenHeight);
    }

    // Get systems
    const terrainSystem =
      this.game.entities.tryGetSingleton(TerrainSystem) ?? null;
    const waterSystem = this.game.entities.tryGetSingleton(WaterSystem) ?? null;

    // Debug: Log once on first render
    if (!this.previousRect) {
      console.log("[SurfaceRenderer] First render:", {
        terrainSystem: !!terrainSystem,
        waterSystem: !!waterSystem,
        screenSize: `${screenWidth}x${screenHeight}`,
        renderRect: this.currentRect,
      });
    }

    // Execute rendering pipeline
    const commandEncoder = device.createCommandEncoder({
      label: "SurfaceRenderer Frame",
    });

    // Pass 1: Render terrain
    if (terrainSystem && this.terrainPass && this.terrainTexture) {
      this.terrainPass.render(
        commandEncoder,
        this.terrainTexture,
        this.currentRect,
        terrainSystem,
      );
    } else {
      console.warn("[SurfaceRenderer] Skipping terrain pass:", {
        terrainSystem: !!terrainSystem,
        terrainPass: !!this.terrainPass,
        terrainTexture: !!this.terrainTexture,
      });
    }

    // Pass 2: Render water
    if (waterSystem && this.waterPass && this.waterTexture) {
      this.waterPass.render(
        commandEncoder,
        this.waterTexture,
        this.currentRect,
        waterSystem,
        terrainSystem,
      );
    } else {
      console.warn("[SurfaceRenderer] Skipping water pass:", {
        waterSystem: !!waterSystem,
        waterPass: !!this.waterPass,
        waterTexture: !!this.waterTexture,
      });
    }

    // Pass 3: Update wetness
    if (this.wetnessPass && this.wetnessTextureA && this.wetnessTextureB) {
      // Determine input/output based on ping-pong index
      const inputTexture =
        this.wetnessPingPongIndex === 0
          ? this.wetnessTextureA
          : this.wetnessTextureB;
      const outputTexture =
        this.wetnessPingPongIndex === 0
          ? this.wetnessTextureB
          : this.wetnessTextureA;

      this.wetnessPass.render(
        commandEncoder,
        inputTexture,
        outputTexture,
        this.waterTexture!, // Already checked non-null at start of Pass 3
        this.currentRect,
        this.previousRect ?? this.currentRect, // Fallback to current on first frame
      );

      // Flip ping-pong index
      this.wetnessPingPongIndex = 1 - this.wetnessPingPongIndex;
    }

    // Submit compute passes
    device.queue.submit([commandEncoder.finish()]);

    // Pass 4: Composite to offscreen texture
    if (
      this.compositePass &&
      this.terrainTexture &&
      this.waterTexture &&
      this.wetnessTextureA &&
      this.wetnessTextureB &&
      this.compositeTexture
    ) {
      const currentWetnessTexture =
        this.wetnessPingPongIndex === 0
          ? this.wetnessTextureA
          : this.wetnessTextureB;

      // Render to offscreen composite texture
      const compositeView = this.compositeTexture.view;

      // Create render pass for offscreen texture
      const renderEncoder = device.createCommandEncoder({
        label: "SurfaceRenderer Composite",
      });

      const renderPass = renderEncoder.beginRenderPass({
        label: "Composite Pass",
        colorAttachments: [
          {
            view: compositeView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });

      this.compositePass.renderComposite(
        renderPass,
        this.terrainTexture,
        this.waterTexture,
        currentWetnessTexture,
      );

      renderPass.end();
      device.queue.submit([renderEncoder.finish()]);
    }
  }

  /**
   * Clean up GPU resources
   */
  @on("destroy")
  onDestroy(): void {
    this.deallocateTextures();

    this.terrainPass?.destroy();
    this.terrainPass = null;

    this.waterPass?.destroy();
    this.waterPass = null;

    this.wetnessPass?.destroy();
    this.wetnessPass = null;

    this.compositePass?.destroy();
    this.compositePass = null;

    this.isInitialized = false;
  }

  /**
   * Compute render rectangle from camera viewport.
   * Adds 2-pixel margin to avoid edge artifacts.
   */
  private computeRenderRect(
    camera: Camera2d,
    screenWidth: number,
    screenHeight: number,
  ): RenderRect {
    const viewport = camera.getWorldViewport();
    const texelScale = viewport.width / screenWidth;
    const margin = texelScale * 2; // 2-pixel margin

    return {
      x: viewport.left - margin,
      y: viewport.top - margin,
      width: viewport.width + 2 * margin,
      height: viewport.height + 2 * margin,
      texelScale,
    };
  }

  /**
   * Allocate render target textures
   */
  private allocateTextures(width: number, height: number): void {
    const device = getWebGPU().device;

    // Terrain texture: rgba16float (height, material ID, unused, unused)
    // Note: rg16float doesn't support storage binding
    this.terrainTexture = device.createTexture({
      label: "SurfaceRenderer Terrain",
      size: { width, height },
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // Water texture: rgba16float (height, normalX, normalY, foam)
    this.waterTexture = device.createTexture({
      label: "SurfaceRenderer Water",
      size: { width, height },
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // Wetness textures: r32float (ping-pong buffers)
    // Note: r8unorm doesn't support storage binding
    this.wetnessTextureA = device.createTexture({
      label: "SurfaceRenderer Wetness A",
      size: { width, height },
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    this.wetnessTextureB = device.createTexture({
      label: "SurfaceRenderer Wetness B",
      size: { width, height },
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });

    // Composite texture: rgba8unorm (offscreen render target)
    const compositeGPUTexture = device.createTexture({
      label: "SurfaceRenderer Composite",
      size: { width, height },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Wrap in WebGPUTexture format for draw.image
    this.compositeTexture = {
      texture: compositeGPUTexture,
      view: compositeGPUTexture.createView(),
      width,
      height,
    };

    console.log(`[SurfaceRenderer] Allocated textures: ${width}x${height}`);
  }

  /**
   * Deallocate render target textures
   */
  private deallocateTextures(): void {
    this.terrainTexture?.destroy();
    this.terrainTexture = null;

    this.waterTexture?.destroy();
    this.waterTexture = null;

    this.wetnessTextureA?.destroy();
    this.wetnessTextureA = null;

    this.wetnessTextureB?.destroy();
    this.wetnessTextureB = null;

    this.compositeTexture?.texture.destroy();
    this.compositeTexture = null;
  }
}
