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
  /** Indirection table mapping tile coords to texture indices */
  indirectionTable: { type: "storage" },
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
@group(0) @binding(2) var<storage, read> indirectionTable: array<i32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params: RenderParams;

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
  tilesMinX: f32,      // Min tile X coordinate in indirection table
  tilesMinY: f32,      // Min tile Y coordinate in indirection table
  tilesPerRow: f32,    // Number of tiles per row in indirection table
  defaultDepth: f32,   // Fallback depth when tile not loaded
}

// ============================================================================
// Terrain Sampling Functions
// ============================================================================

fn getTileTextureIndex(tileX: i32, tileY: i32) -> i32 {
  let relX = tileX - i32(params.tilesMinX);
  let relY = tileY - i32(params.tilesMinY);

  if (relX < 0 || relY < 0 || relX >= i32(params.tilesPerRow)) {
    return -1;  // Out of bounds
  }

  let index = relY * i32(params.tilesPerRow) + relX;
  return indirectionTable[index];
}

fn sampleTerrainHeight(worldX: f32, worldY: f32) -> f32 {
  let tileWorldSize = params.tileSize;  // LOD 0 for now

  let tileX = i32(floor(worldX / tileWorldSize));
  let tileY = i32(floor(worldY / tileWorldSize));

  let textureIndex = getTileTextureIndex(tileX, tileY);

  if (textureIndex < 0) {
    return params.defaultDepth;  // Tile not loaded
  }

  let tileWorldX = f32(tileX) * tileWorldSize;
  let tileWorldY = f32(tileY) * tileWorldSize;
  let u = (worldX - tileWorldX) / tileWorldSize;
  let v = (worldY - tileWorldY) / tileWorldSize;

  let heightSample = textureSampleLevel(
    terrainTiles, terrainSampler, vec2f(u, v), textureIndex, 0.0
  );

  return heightSample.r;
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

  // Sample real terrain height from VirtualTexture
  let terrainHeight = sampleTerrainHeight(worldX, worldY);
  let materialId = 0.0;  // Stub for Phase 2

  // Write to output (rgba16float: height, materialId, unused, unused)
  textureStore(output, vec2u(pixelX, pixelY), vec4f(terrainHeight, materialId, 0.0, 0.0));
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
  private indirectionBuffer: GPUBuffer | null = null;
  private indirectionBufferSize = 0;
  private sampler: GPUSampler | null = null;

  /**
   * Initialize GPU resources
   */
  async init(): Promise<void> {
    await super.init();

    const device = getWebGPU().device;

    // Create params buffer (12 floats)
    this.paramsBuffer = device.createBuffer({
      label: "TerrainRenderPass Params",
      size: 12 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create initial indirection buffer (will be resized as needed)
    this.indirectionBufferSize = 256; // Initial size
    this.indirectionBuffer = device.createBuffer({
      label: "TerrainRenderPass Indirection",
      size: this.indirectionBufferSize * Int32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
    if (!this.paramsBuffer || !this.sampler || !this.indirectionBuffer) {
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

    // Calculate tile bounds
    const lod = 0;
    const tileWorldSize = 128.0;
    const tilesMinX = Math.floor(renderRect.x / tileWorldSize);
    const tilesMinY = Math.floor(renderRect.y / tileWorldSize);
    const tilesMaxX = Math.floor(
      (renderRect.x + renderRect.width) / tileWorldSize,
    );
    const tilesMaxY = Math.floor(
      (renderRect.y + renderRect.height) / tileWorldSize,
    );
    const tilesPerRow = tilesMaxX - tilesMinX + 1;
    const tilesPerCol = tilesMaxY - tilesMinY + 1;

    // Build indirection table from VirtualTexture cache
    const indirectionData = new Int32Array(tilesPerRow * tilesPerCol);
    indirectionData.fill(-1); // Default: tile not loaded

    for (let tileY = tilesMinY; tileY <= tilesMaxY; tileY++) {
      for (let tileX = tilesMinX; tileX <= tilesMaxX; tileX++) {
        const tile = terrainSystem.getTileFromCache(lod, tileX, tileY);
        if (tile) {
          const relX = tileX - tilesMinX;
          const relY = tileY - tilesMinY;
          indirectionData[relY * tilesPerRow + relX] = tile.textureIndex;
        }
      }
    }

    // Resize indirection buffer if needed
    const requiredSize = indirectionData.length;
    if (requiredSize > this.indirectionBufferSize) {
      this.indirectionBuffer.destroy();
      this.indirectionBufferSize = Math.max(
        requiredSize,
        this.indirectionBufferSize * 2,
      );
      this.indirectionBuffer = device.createBuffer({
        label: "TerrainRenderPass Indirection",
        size: this.indirectionBufferSize * Int32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }

    // Upload indirection table
    device.queue.writeBuffer(this.indirectionBuffer, 0, indirectionData);

    // Update params buffer
    const paramsData = new Float32Array([
      renderRect.x,
      renderRect.y,
      renderRect.width,
      renderRect.height,
      tileWorldSize, // tileSize
      outputTexture.width,
      outputTexture.height,
      tilesMinX,
      tilesMinY,
      tilesPerRow,
      terrainSystem.getDefaultDepth(),
      0.0, // padding (12 floats total)
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
      indirectionTable: { buffer: this.indirectionBuffer },
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

    this.indirectionBuffer?.destroy();
    this.indirectionBuffer = null;

    this.sampler = null;
  }
}
