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
import { generateWGSLBindings } from "../../../../core/graphics/webgpu/ShaderBindings";
import { SPLINE_SUBDIVISIONS } from "../TerrainConstants";
import { TerrainParams } from "./TerrainComputeBuffers";
import {
  terrainStructuresModule,
  catmullRomModule,
  distanceModule,
  idwModule,
  terrainHeightCoreModule,
} from "../../../world/shaders/terrain.wgsl";

/**
 * Terrain render shader using vertex + fragment shaders.
 * Replaces compute shader for better containment detection via depth testing.
 */
export class TerrainStateShader {
  private pipeline: GPURenderPipeline | null = null;
  private oceanPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  private buildShaderCode(): string {
    // Collect modules manually (Option A - manual composition)
    const modules = [
      terrainStructuresModule,
      catmullRomModule,
      distanceModule,
      idwModule,
      terrainHeightCoreModule,
    ];

    // Build code from modules
    const moduleCodes = modules.map((m) => m.code).join("\n\n");

    // Define bindings with wgslType
    const bindings = {
      params: { type: "uniform", wgslType: "Params" },
      controlPoints: { type: "storage", wgslType: "array<vec2<f32>>" },
      contours: { type: "storage", wgslType: "array<ContourData>" },
      children: { type: "storage", wgslType: "array<u32>" },
    } as const;

    // Generate WGSL bindings
    const bindingsWGSL = generateWGSLBindings(bindings, 0);

    // Build complete shader code
    return /*wgsl*/ `
// ============================================================================
// Fundamental math constants (always included)
// ============================================================================
const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;

// ============================================================================
// Terrain Constants
// ============================================================================
const SPLINE_SUBDIVISIONS: u32 = ${SPLINE_SUBDIVISIONS}u;

// ============================================================================
// Terrain Modules
// ============================================================================
${moduleCodes}

// ============================================================================
// Params and Bindings
// ============================================================================
${TerrainParams.wgsl}

// ContourData struct is provided by terrainStructuresModule

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) contourIndex: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec2<f32>,
  @location(1) @interpolate(flat) contourIndex: u32,
}

${bindingsWGSL}

// ============================================================================
// Wrapper for module function
// ============================================================================

// Compute signed distance to a contour (wrapper for module function)
fn computeSignedDistanceWrapper(worldPos: vec2<f32>, contourIndex: u32) -> f32 {
  return computeSignedDistance(
    worldPos,
    contourIndex,
    &controlPoints,
    &contours,
    SPLINE_SUBDIVISIONS
  );
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
  let parentSignedDist = computeSignedDistanceWrapper(worldPos, contourIndex);
  let parentDist = max(minDist, abs(parentSignedDist));
  let parentWeight = 1.0 / parentDist;
  var weightedSum = contour.height * parentWeight;
  var weightSum = parentWeight;

  // Each child participates with distance-based weight
  for (var i: u32 = 0u; i < contour.childCount; i++) {
    let childIdx = children[contour.childStartIndex + i];
    let child = contours[childIdx];

    // Compute signed distance to child
    let signedDist = computeSignedDistanceWrapper(worldPos, childIdx);
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
      let signedDist = computeSignedDistanceWrapper(input.worldPos, i);
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
  }

  async init(): Promise<void> {
    const device = getWebGPU().device;
    const shaderCode = this.buildShaderCode();

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
      code: shaderCode,
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
