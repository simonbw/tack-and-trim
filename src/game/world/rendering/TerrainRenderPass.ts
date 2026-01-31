import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import type { BindingsDefinition } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { TerrainSystem } from "../terrain/TerrainSystem";
import type { RenderRect } from "./SurfaceRenderer";

/**
 * Bindings for terrain rendering compute shader
 */
const TerrainRenderBindings = {
  /** Virtual texture array containing terrain tiles */
  terrainTiles: { type: "texture", viewDimension: "2d-array" },
  /** Sampler for terrain tiles */
  terrainSampler: { type: "sampler" },
  /** Output texture (rgba16float: height, material ID, unused, unused) */
  output: { type: "storageTexture", format: "rgba16float" },
  /** Render parameters (renderRect, tileSize, etc.) */
  params: { type: "uniform" },
} as const satisfies BindingsDefinition;

/**
 * WGSL compute shader for terrain rendering.
 * Samples TerrainSystem's VirtualTexture and outputs height + material ID.
 */
const TERRAIN_RENDER_SHADER = /* wgsl */ `

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var terrainTiles: texture_2d_array<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: RenderParams;

// ============================================================================
// Structs
// ============================================================================

struct RenderParams {
  renderX: f32,        // World X of render rect
  renderY: f32,        // World Y of render rect
  renderWidth: f32,    // World width of render rect
  renderHeight: f32,   // World height of render rect
  tileSize: f32,       // Virtual texture tile size in world units (LOD 0)
  outputWidth: f32,    // Output texture width in pixels
  outputHeight: f32,   // Output texture height in pixels
  _padding: f32,
}

// ============================================================================
// Main Compute Kernel
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  // Get output pixel coordinates
  let pixelX = globalId.x;
  let pixelY = globalId.y;

  // Bounds check
  if (pixelX >= u32(params.outputWidth) || pixelY >= u32(params.outputHeight)) {
    return;
  }

  // Compute world position for this pixel
  let u = f32(pixelX) / params.outputWidth;
  let v = f32(pixelY) / params.outputHeight;
  let worldX = params.renderX + u * params.renderWidth;
  let worldY = params.renderY + v * params.renderHeight;

  // Sample terrain from virtual texture (LOD 0 for now)
  let lod = 0.0;
  let tileSize = params.tileSize;

  // Compute tile coordinates
  let tileCoordX = worldX / tileSize;
  let tileCoordY = worldY / tileSize;

  // Compute tile index and UV within tile
  let tileX = floor(tileCoordX);
  let tileY = floor(tileCoordY);
  let tileU = fract(tileCoordX);
  let tileV = fract(tileCoordY);

  // TODO: Implement proper VirtualTexture tile mapping
  // For now, output a simple test pattern based on world position

  // Create a gradient based on world position
  let heightGradient = sin(worldX * 0.01) * cos(worldY * 0.01) * 10.0;
  let testHeight = heightGradient - 5.0; // Range roughly -15 to +5
  let testMaterial = 0.0;

  // Write to output (rgba16float: height, materialId, unused, unused)
  textureStore(output, vec2u(pixelX, pixelY), vec4f(testHeight, testMaterial, 0.0, 0.0));
}
`;

/**
 * TerrainRenderPass: Samples TerrainSystem VirtualTexture and outputs to screen-sized texture.
 */
export class TerrainRenderPass extends ComputeShader<
  typeof TerrainRenderBindings
> {
  readonly code = TERRAIN_RENDER_SHADER;
  readonly bindings = TerrainRenderBindings;
  readonly workgroupSize = [8, 8] as const;

  // Reusable resources
  private paramsBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  /**
   * Initialize GPU resources
   */
  async init(): Promise<void> {
    await super.init();

    const device = getWebGPU().device;

    // Create params buffer (8 floats)
    this.paramsBuffer = device.createBuffer({
      label: "TerrainRenderPass Params",
      size: 8 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create sampler (linear filtering)
    this.sampler = device.createSampler({
      label: "TerrainRenderPass Sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  /**
   * Render terrain to output texture
   */
  render(
    encoder: GPUCommandEncoder,
    outputTexture: GPUTexture,
    renderRect: RenderRect,
    terrainSystem: TerrainSystem,
  ): void {
    if (!this.paramsBuffer || !this.sampler) {
      console.warn("[TerrainRenderPass] Not initialized");
      return;
    }

    // Get terrain VirtualTexture
    const terrainTexture = terrainSystem.getTerrainTexture();
    if (!terrainTexture) {
      console.warn("[TerrainRenderPass] No terrain texture available");
      return;
    }

    const device = getWebGPU().device;

    // Update params buffer
    const paramsData = new Float32Array([
      renderRect.x,
      renderRect.y,
      renderRect.width,
      renderRect.height,
      128.0, // tileSize (default for VirtualTexture)
      outputTexture.width,
      outputTexture.height,
      0.0, // padding
    ]);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Create bind group
    const terrainView = terrainTexture.createView({
      dimension: "2d-array",
    });

    const outputView = outputTexture.createView();

    const bindGroup = this.createBindGroup({
      terrainTiles: terrainView,
      terrainSampler: this.sampler,
      output: outputView,
      params: { buffer: this.paramsBuffer },
    });

    // Dispatch compute shader
    const computePass = encoder.beginComputePass({
      label: "TerrainRenderPass",
    });

    this.dispatch(
      computePass,
      bindGroup,
      outputTexture.width,
      outputTexture.height,
    );

    computePass.end();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    super.destroy();

    this.paramsBuffer?.destroy();
    this.paramsBuffer = null;

    this.sampler = null;
  }
}
