/**
 * Water surface rendering shader.
 *
 * Uses WaterSurfaceShader for rendering the water surface with:
 * - Combined wave + modifier height data from unified compute shader
 * - Optional terrain height data for depth-based sand/water blending
 * - Surface normal calculation from height gradients
 * - Fresnel, subsurface scattering, and specular lighting
 */

import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import { WaterSurfaceShader } from "./WaterSurfaceShader";

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Water surface rendering shader with terrain support.
 */
export class SurfaceShader {
  private shader: WaterSurfaceShader;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  // Placeholder texture for when terrain is not available
  private placeholderTerrainTexture: GPUTexture | null = null;
  private placeholderTerrainView: GPUTextureView | null = null;

  // Uniform data
  private uniformData: Float32Array;

  // Cached bind group (recreated when texture changes)
  private bindGroup: GPUBindGroup | null = null;
  private lastWaterTexture: GPUTextureView | null = null;
  private lastTerrainTexture: GPUTextureView | null = null;

  constructor() {
    this.shader = new WaterSurfaceShader();

    // Uniform buffer layout (96 bytes total for WebGPU 16-byte alignment):
    // Indices 0-11:  mat3x3 (3x vec4 = 48 bytes, padded columns)
    // Index 12:      time (f32)
    // Index 13:      renderMode (i32 as f32)
    // Index 14-15:   screenWidth, screenHeight (f32)
    // Index 16-19:   viewport bounds (left, top, width, height) (f32)
    // Index 20:      colorNoiseStrength (f32)
    // Index 21:      hasTerrainData (i32 as f32)
    // Index 22:      shallowThreshold (f32)
    // Index 23:      unused (padding to 96 bytes)
    this.uniformData = new Float32Array(24); // 96 bytes / 4

    // Default values
    this.uniformData[21] = 0; // hasTerrainData
    this.uniformData[22] = SHALLOW_WATER_THRESHOLD; // shallowThreshold
  }

  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Initialize shader
    await this.shader.init();

    // Create uniform buffer
    this.uniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Water Surface Uniform Buffer",
    });

    // Create sampler
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Create placeholder terrain texture (1x1 deep water = no terrain)
    // Must match terrain texture format (rgba32float)
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
  }

  /**
   * Set the camera inverse matrix (screen to world).
   */
  setCameraMatrix(matrix: Float32Array): void {
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

  setTime(time: number): void {
    this.uniformData[12] = time;
  }

  setRenderMode(mode: number): void {
    // Store as float, will be converted to int in shader
    this.uniformData[13] = mode;
  }

  setScreenSize(width: number, height: number): void {
    this.uniformData[14] = width;
    this.uniformData[15] = height;
  }

  setViewportBounds(
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

  setColorNoiseStrength(value: number): void {
    this.uniformData[20] = value;
  }

  setHasTerrainData(hasTerrain: boolean): void {
    this.uniformData[21] = hasTerrain ? 1 : 0;
  }

  setShallowThreshold(threshold: number): void {
    this.uniformData[22] = threshold;
  }

  /**
   * Render the water surface.
   */
  render(
    renderPass: GPURenderPassEncoder,
    waterTextureView: GPUTextureView,
    terrainTextureView?: GPUTextureView | null,
  ): void {
    if (!this.uniformBuffer || !this.sampler) {
      return;
    }

    const device = getWebGPU().device;

    // Use placeholder if no terrain texture
    const effectiveTerrainView =
      terrainTextureView ?? this.placeholderTerrainView!;
    this.setHasTerrainData(!!terrainTextureView);

    // Upload uniforms
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
      });
      this.lastWaterTexture = waterTextureView;
      this.lastTerrainTexture = effectiveTerrainView;
    }

    // Render using shader
    this.shader.render(renderPass, this.bindGroup);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.placeholderTerrainTexture?.destroy();
    this.shader.destroy();
    this.bindGroup = null;
  }
}
