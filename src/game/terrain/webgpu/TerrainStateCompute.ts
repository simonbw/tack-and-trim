/**
 * Terrain state compute shader.
 *
 * This class owns the compute pipeline and provides the bind group layout.
 * Callers (TerrainDataTileCompute instances) create their own bind groups and output textures.
 *
 * Computes terrain height using:
 * - Catmull-Rom splines for coastline definition
 * - Signed distance field for inside/outside determination
 * - Smoothstep beach profile
 * - Simplex noise for rolling hills
 *
 * Output format (rgba16float):
 * - R: Signed height in world units (negative = underwater depth, positive = terrain height)
 * - GBA: Reserved
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { SIMPLEX_NOISE_3D_WGSL } from "../../../core/graphics/webgpu/WGSLSnippets";
import { TERRAIN_CONSTANTS_WGSL } from "../TerrainConstants";

/**
 * WGSL compute shader for terrain height computation.
 */
export const TERRAIN_STATE_SHADER = /*wgsl*/ `
${TERRAIN_CONSTANTS_WGSL}

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  landMassCount: u32,
}

struct LandMassData {
  startIndex: u32,
  pointCount: u32,
  peakHeight: f32,
  beachWidth: f32,
  hillFrequency: f32,
  hillAmplitude: f32,
  _padding1: f32,
  _padding2: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> landMasses: array<LandMassData>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba16float, write>;

// Default water depth when no terrain (deep ocean)
const DEFAULT_WATER_DEPTH: f32 = -50.0;

// Include simplex 3D noise (use with z=0 for 2D noise)
${SIMPLEX_NOISE_3D_WGSL}

// Use simplex3D with z=0 for 2D noise
fn simplex2D(p: vec2<f32>) -> f32 {
  return simplex3D(vec3<f32>(p.x, p.y, 0.0));
}

// ============================================================================
// Catmull-Rom spline evaluation
// ============================================================================

fn catmullRomPoint(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * (
    2.0 * p1 +
    (-p0 + p2) * t +
    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
  );
}

// ============================================================================
// Distance functions
// ============================================================================

fn pointToSegmentDistance(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ab = b - a;
  let lengthSq = dot(ab, ab);
  if (lengthSq == 0.0) {
    return length(p - a);
  }
  let t = clamp(dot(p - a, ab) / lengthSq, 0.0, 1.0);
  let nearest = a + t * ab;
  return length(p - nearest);
}

// Returns positive if p is to the left of line a->b
fn isLeft(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

// ============================================================================
// Signed distance computation for a land mass
// ============================================================================

fn computeSignedDistance(worldPos: vec2<f32>, lmIndex: u32) -> f32 {
  let lm = landMasses[lmIndex];
  let n = lm.pointCount;
  let start = lm.startIndex;

  var minDist: f32 = 1e10;
  var windingNumber: i32 = 0;

  // For each control point pair, subdivide Catmull-Rom and check distance
  for (var i: u32 = 0u; i < n; i++) {
    // Get indices for Catmull-Rom (wrapping for closed loop)
    let i0 = (i + n - 1u) % n;
    let i1 = i;
    let i2 = (i + 1u) % n;
    let i3 = (i + 2u) % n;

    let p0 = controlPoints[start + i0];
    let p1 = controlPoints[start + i1];
    let p2 = controlPoints[start + i2];
    let p3 = controlPoints[start + i3];

    // Subdivide this curve segment
    for (var j: u32 = 0u; j < SPLINE_SUBDIVISIONS; j++) {
      let t0 = f32(j) / f32(SPLINE_SUBDIVISIONS);
      let t1 = f32(j + 1u) / f32(SPLINE_SUBDIVISIONS);

      let a = catmullRomPoint(p0, p1, p2, p3, t0);
      let b = catmullRomPoint(p0, p1, p2, p3, t1);

      // Distance to segment
      let dist = pointToSegmentDistance(worldPos, a, b);
      minDist = min(minDist, dist);

      // Winding number contribution (crossing number algorithm)
      if (a.y <= worldPos.y) {
        if (b.y > worldPos.y && isLeft(a, b, worldPos) > 0.0) {
          windingNumber += 1;
        }
      } else {
        if (b.y <= worldPos.y && isLeft(a, b, worldPos) < 0.0) {
          windingNumber -= 1;
        }
      }
    }
  }

  // Inside if winding number is non-zero
  let inside = windingNumber != 0;
  return select(minDist, -minDist, inside);
}

// ============================================================================
// Height profile computation
// ============================================================================

fn computeHeightProfile(worldPos: vec2<f32>, signedDist: f32, lmIndex: u32) -> f32 {
  let lm = landMasses[lmIndex];
  let distInland = -signedDist;  // signedDist is negative inside

  // Beach smoothstep: 0 at shore, 1 at beachWidth inland
  let beachFactor = smoothstep(0.0, lm.beachWidth, distInland);
  let baseHeight = beachFactor * lm.peakHeight;

  // Rolling hills via noise
  let hillNoise = simplex2D(worldPos * lm.hillFrequency);
  let hillVariation = 1.0 + hillNoise * lm.hillAmplitude;

  return baseHeight * hillVariation;
}

// ============================================================================
// Main compute entry point
// ============================================================================

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Check bounds
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert pixel coords to UV (0-1)
  let uv = (vec2<f32>(globalId.xy) + 0.5) / texSize;

  // Map UV to world position
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  // Start with default deep water
  var terrainHeight: f32 = DEFAULT_WATER_DEPTH;

  // Check each land mass
  for (var i: u32 = 0u; i < params.landMassCount; i++) {
    let signedDist = computeSignedDistance(worldPos, i);
    if (signedDist < 0.0) {
      // Inside this land mass - compute positive height above sea level
      let height = computeHeightProfile(worldPos, signedDist, i);
      terrainHeight = max(terrainHeight, height);
    } else {
      // Outside land mass - compute depth based on distance to shore
      // Shallow near shore, deeper further out
      let shoreDepth = -min(signedDist * 0.5, 50.0);
      terrainHeight = max(terrainHeight, shoreDepth);
    }
  }

  // Store signed height directly (negative = underwater, positive = above water)
  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(terrainHeight, 0.0, 0.0, 1.0));
}
`;

/**
 * Terrain state compute shader.
 *
 * This class owns the compute pipeline and provides the bind group layout.
 * Callers create their own bind groups and output textures.
 */
export class TerrainStateCompute {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  /**
   * Initialize the compute pipeline.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: TERRAIN_STATE_SHADER,
      label: "Terrain State Compute Shader",
    });

    // Create bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba16float",
            viewDimension: "2d",
          },
        },
      ],
      label: "Terrain State Bind Group Layout",
    });

    // Create compute pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Terrain State Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: "Terrain State Compute Pipeline",
    });
  }

  /**
   * Get the bind group layout for creating bind groups.
   */
  getBindGroupLayout(): GPUBindGroupLayout {
    if (!this.bindGroupLayout) {
      throw new Error("TerrainStateCompute not initialized");
    }
    return this.bindGroupLayout;
  }

  /**
   * Get the compute pipeline.
   */
  getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      throw new Error("TerrainStateCompute not initialized");
    }
    return this.pipeline;
  }

  /**
   * Dispatch the compute shader.
   *
   * @param computePass - The compute pass to dispatch on
   * @param bindGroup - Bind group with buffers and output texture
   * @param textureSize - Size of the output texture
   */
  dispatch(
    computePass: GPUComputePassEncoder,
    bindGroup: GPUBindGroup,
    textureSize: number
  ): void {
    if (!this.pipeline) {
      console.warn("TerrainStateCompute not initialized");
      return;
    }

    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(textureSize / 8);
    const workgroupsY = Math.ceil(textureSize / 8);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
