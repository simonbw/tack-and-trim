/**
 * Terrain state render shader.
 *
 * Uses GPU rasterization for efficient contour containment detection:
 * - Contours are tessellated to triangles and rendered front-to-back
 * - Depth testing determines which contour contains each pixel
 * - Fragment shader computes height using IDW blending with children
 *
 * Output format (rgba32float):
 * - R: Signed height in world units (negative = underwater depth, positive = terrain height)
 * - GBA: Reserved
 */

import { getWebGPU } from "../../../../core/graphics/webgpu/WebGPUDevice";
import { TERRAIN_CONSTANTS_WGSL } from "../TerrainConstants";

/**
 * Terrain render shader using vertex + fragment shaders.
 * Replaces compute shader for better containment detection via depth testing.
 */
export class TerrainStateShader {
  private pipeline: GPURenderPipeline | null = null;
  private oceanPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  private readonly shaderCode = /*wgsl*/ `
${TERRAIN_CONSTANTS_WGSL}

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  contourCount: u32,
  defaultDepth: f32,
  maxDepth: u32,
  _padding1: f32,
  _padding2: f32,
}

struct ContourData {
  pointStartIndex: u32,
  pointCount: u32,
  height: f32,
  parentIndex: i32,
  depth: u32,
  childStartIndex: u32,
  childCount: u32,
  _padding1: u32,
  _padding2: u32,
}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) contourIndex: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec2<f32>,
  @location(1) @interpolate(flat) contourIndex: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> contours: array<ContourData>;
@group(0) @binding(3) var<storage, read> children: array<u32>;

// ============================================================================
// Catmull-Rom spline evaluation (for distance computation in fragment shader)
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

fn isLeft(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

// Compute signed distance to a contour
fn computeSignedDistance(worldPos: vec2<f32>, contourIndex: u32) -> f32 {
  let c = contours[contourIndex];
  let n = c.pointCount;
  let start = c.pointStartIndex;

  var minDist: f32 = 1e10;
  var windingNumber: i32 = 0;

  for (var i: u32 = 0u; i < n; i++) {
    let i0 = (i + n - 1u) % n;
    let i1 = i;
    let i2 = (i + 1u) % n;
    let i3 = (i + 2u) % n;

    let p0 = controlPoints[start + i0];
    let p1 = controlPoints[start + i1];
    let p2 = controlPoints[start + i2];
    let p3 = controlPoints[start + i3];

    for (var j: u32 = 0u; j < SPLINE_SUBDIVISIONS; j++) {
      let t0 = f32(j) / f32(SPLINE_SUBDIVISIONS);
      let t1 = f32(j + 1u) / f32(SPLINE_SUBDIVISIONS);

      let a = catmullRomPoint(p0, p1, p2, p3, t0);
      let b = catmullRomPoint(p0, p1, p2, p3, t1);

      let dist = pointToSegmentDistance(worldPos, a, b);
      minDist = min(minDist, dist);

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

  let inside = windingNumber != 0;
  return select(minDist, -minDist, inside);
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // World position passed from tessellated geometry
  let worldPos = input.position;

  // Convert world position to UV coordinates
  let uv = (worldPos - vec2<f32>(params.viewportLeft, params.viewportTop)) /
           vec2<f32>(params.viewportWidth, params.viewportHeight);

  // Get contour depth for z-coordinate (deeper = closer to camera = smaller z)
  let contour = contours[input.contourIndex];
  let maxDepthF = f32(params.maxDepth);
  // Invert depth so deeper contours are "closer" and win depth test
  let z = select(0.0, (maxDepthF - f32(contour.depth)) / (maxDepthF + 1.0), maxDepthF > 0.0);

  // Convert UV to clip space (-1 to 1)
  let clipPos = uv * 2.0 - 1.0;
  // Flip Y for standard clip coordinates
  output.position = vec4<f32>(clipPos.x, -clipPos.y, z, 1.0);
  output.worldPos = worldPos;
  output.contourIndex = input.contourIndex;

  return output;
}

// ============================================================================
// Fragment Shader - IDW Height Computation
// ============================================================================

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let contourIndex = input.contourIndex;
  let worldPos = input.worldPos;
  let contour = contours[contourIndex];

  // If no children, return height directly
  if (contour.childCount == 0u) {
    return vec4<f32>(contour.height, 0.0, 0.0, 1.0);
  }

  // Has children - use pure IDW blending where parent and children all participate
  let minDist: f32 = 0.1;

  // Parent participates in IDW based on distance to its own boundary
  let parentSignedDist = computeSignedDistance(worldPos, contourIndex);
  let parentDist = max(minDist, abs(parentSignedDist));
  let parentWeight = 1.0 / parentDist;
  var weightedSum = contour.height * parentWeight;
  var weightSum = parentWeight;

  // Each child participates with distance-based weight
  for (var i: u32 = 0u; i < contour.childCount; i++) {
    let childIdx = children[contour.childStartIndex + i];
    let child = contours[childIdx];

    // Compute signed distance to child
    let signedDist = computeSignedDistance(worldPos, childIdx);
    let dist = max(minDist, abs(signedDist));

    // IDW weight
    let weight = 1.0 / dist;
    weightedSum += child.height * weight;
    weightSum += weight;
  }

  return vec4<f32>(weightedSum / weightSum, 0.0, 0.0, 1.0);
}

// ============================================================================
// Ocean Fragment Shader - IDW between root contours
// ============================================================================

struct OceanVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec2<f32>,
}

@vertex
fn oceanVertexMain(@builtin(vertex_index) vertexIndex: u32) -> OceanVertexOutput {
  // Full-screen quad
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0)
  );

  var output: OceanVertexOutput;
  let clipPos = positions[vertexIndex];

  // Convert clip space to world position
  // Clip is -1 to 1, UV is 0 to 1
  let uv = clipPos * 0.5 + 0.5;
  // Flip Y back since clip Y is flipped in vertex shader
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + (1.0 - uv.y) * params.viewportHeight
  );

  output.position = vec4<f32>(clipPos, 1.0, 1.0);
  output.worldPos = worldPos;
  return output;
}

@fragment
fn oceanFragmentMain(input: OceanVertexOutput) -> @location(0) vec4<f32> {
  let minDist: f32 = 0.1;

  var weightedSum: f32 = 0.0;
  var weightSum: f32 = 0.0;

  // Iterate over all contours to find root contours and use IDW
  for (var i: u32 = 0u; i < params.contourCount; i++) {
    let contour = contours[i];
    // Root contours have parentIndex == -1
    if (contour.parentIndex == -1) {
      // Compute signed distance to this root contour
      let signedDist = computeSignedDistance(input.worldPos, i);
      // Only consider if we're outside (positive distance)
      if (signedDist >= 0.0) {
        let dist = max(minDist, signedDist);
        let weight = 1.0 / dist;
        weightedSum += contour.height * weight;
        weightSum += weight;
      }
    }
  }

  // Use IDW result if valid, otherwise fall back to default depth
  if (weightSum > 0.0) {
    return vec4<f32>(weightedSum / weightSum, 0.0, 0.0, 1.0);
  }

  return vec4<f32>(params.defaultDepth, 0.0, 0.0, 1.0);
}
`;

  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Create bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: "Terrain Render Bind Group Layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    const shaderModule = device.createShaderModule({
      label: "Terrain State Shader",
      code: this.shaderCode,
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "Terrain Render Pipeline Layout",
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Main render pipeline for contours
    this.pipeline = device.createRenderPipeline({
      label: "Terrain Contour Render Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: [
          {
            arrayStride: 12, // 2 floats (position) + 1 u32 (contourIndex)
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "uint32" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba32float" }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none",
      },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });

    // Ocean background pipeline (fullscreen quad at z=1)
    this.oceanPipeline = device.createRenderPipeline({
      label: "Terrain Ocean Render Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "oceanVertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "oceanFragmentMain",
        targets: [{ format: "rgba32float" }],
      },
      primitive: {
        topology: "triangle-list",
      },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });
  }

  createBindGroup(entries: {
    params: { buffer: GPUBuffer };
    controlPoints: { buffer: GPUBuffer };
    contours: { buffer: GPUBuffer };
    children: { buffer: GPUBuffer };
  }): GPUBindGroup {
    if (!this.bindGroupLayout) {
      throw new Error("Shader not initialized");
    }

    return getWebGPU().device.createBindGroup({
      label: "Terrain Render Bind Group",
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: entries.params },
        { binding: 1, resource: entries.controlPoints },
        { binding: 2, resource: entries.contours },
        { binding: 3, resource: entries.children },
      ],
    });
  }

  getPipeline(): GPURenderPipeline | null {
    return this.pipeline;
  }

  getOceanPipeline(): GPURenderPipeline | null {
    return this.oceanPipeline;
  }

  destroy(): void {
    // Pipelines are destroyed automatically when no longer referenced
    this.pipeline = null;
    this.oceanPipeline = null;
    this.bindGroupLayout = null;
  }
}
