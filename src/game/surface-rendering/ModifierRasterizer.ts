/**
 * Water Modifier Rasterizer
 *
 * Rasterizes water modifier contributions (wakes, ripples, etc.) to a
 * screen-space rgba16float texture using instanced annular polygons.
 *
 * Each modifier gets an 8-segment annular polygon covering only the ring
 * band where the contribution is significant, avoiding wasted fragments in
 * the AABB corners and empty ring interior. The fragment shader computes
 * the type-specific contribution. Additive blending accumulates height
 * (R channel); max blending preserves peak turbulence (A channel).
 *
 * Output: vec4(height, 0, 0, turbulence)
 * Clear color: (0, 0, 0, 0) = no modifier contribution
 *
 * Reuses the existing modifiersBuffer from WaterResources directly as a
 * storage buffer binding — no new CPU-side data packing needed.
 */

import {
  defineUniformStruct,
  f32,
  u32,
} from "../../core/graphics/UniformStruct";
import type { GPUProfiler } from "../../core/graphics/webgpu/GPUProfiler";
import type { Viewport } from "../wave-physics/WavePhysicsResources";
import { FLOATS_PER_MODIFIER } from "../world/water/WaterResources";

const ModifierRasterizerUniforms = defineUniformStruct("ModifierParams", {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  modifierCount: u32,
  floatsPerModifier: u32,
});

const SHADER_CODE = /*wgsl*/ `
struct ModifierParams {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  modifierCount: u32,
  floatsPerModifier: u32,
}

@group(0) @binding(0) var<uniform> params: ModifierParams;
@group(0) @binding(1) var<storage, read> modifiers: array<f32>;

// 8-segment annular polygon: 8 segments × 6 vertices = 48 vertices per instance
const RING_SEGMENTS: u32 = 8u;
const VERTS_PER_INSTANCE: u32 = 48u; // RING_SEGMENTS * 6
const TWO_PI: f32 = 6.283185307;
// Expand outer radius so inscribed polygon fully covers the circle: 1/cos(π/8)
const POLYGON_COVERAGE: f32 = 1.0824;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec2<f32>,
  @location(1) @interpolate(flat) instanceIndex: u32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let base = instanceIndex * params.floatsPerModifier;
  let modType = u32(modifiers[base + 0u]);

  let minX = modifiers[base + 1u];
  let minY = modifiers[base + 2u];
  let maxX = modifiers[base + 3u];
  let maxY = modifiers[base + 4u];

  // Compute center and inner/outer radii based on modifier type
  var centerX: f32;
  var centerY: f32;
  var innerR: f32;
  var outerR: f32;

  if (modType == 1u) {
    // Wake: ring centered on source position
    centerX = modifiers[base + 5u];
    centerY = modifiers[base + 6u];
    let ringRadius = modifiers[base + 7u];
    let ringWidth = modifiers[base + 8u];
    innerR = max(0.0, ringRadius - 3.0 * ringWidth);
    outerR = ringRadius + 3.0 * ringWidth;
  } else if (modType == 2u) {
    // Ripple: ring centered on AABB center
    centerX = (minX + maxX) * 0.5;
    centerY = (minY + maxY) * 0.5;
    let radius = modifiers[base + 5u];
    innerR = max(0.0, radius - 2.0);
    outerR = radius + 2.0;
  } else {
    // Fallback: filled circle from AABB
    centerX = (minX + maxX) * 0.5;
    centerY = (minY + maxY) * 0.5;
    innerR = 0.0;
    outerR = max(maxX - minX, maxY - minY) * 0.5;
  }

  // Expand outer radius so polygon edges fully cover the circle
  outerR *= POLYGON_COVERAGE;

  // Generate annular polygon vertex
  // Each segment has 6 vertices forming 2 triangles (inner/outer ring band)
  let segment = vertexIndex / 6u;
  let local = vertexIndex % 6u;

  let angle0 = f32(segment) * TWO_PI / f32(RING_SEGMENTS);
  let angle1 = f32(segment + 1u) * TWO_PI / f32(RING_SEGMENTS);

  // 6 vertices per segment: 2 triangles forming a trapezoid
  //   Tri 1: (inner,a0), (outer,a0), (inner,a1)
  //   Tri 2: (inner,a1), (outer,a0), (outer,a1)
  var r: f32;
  var angle: f32;
  switch (local) {
    case 0u: { r = innerR; angle = angle0; }
    case 1u: { r = outerR; angle = angle0; }
    case 2u: { r = innerR; angle = angle1; }
    case 3u: { r = innerR; angle = angle1; }
    case 4u: { r = outerR; angle = angle0; }
    default: { r = outerR; angle = angle1; }
  }

  let worldX = centerX + r * cos(angle);
  let worldY = centerY + r * sin(angle);

  // World → NDC
  let ndcX = 2.0 * (worldX - params.viewportLeft) / params.viewportWidth - 1.0;
  let ndcY = 1.0 - 2.0 * (worldY - params.viewportTop) / params.viewportHeight;

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.worldPos = vec2<f32>(worldX, worldY);
  out.instanceIndex = instanceIndex;
  return out;
}

// Modifier type discriminators
const MODIFIER_TYPE_WAKE: u32 = 1u;
const MODIFIER_TYPE_RIPPLE: u32 = 2u;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let base = in.instanceIndex * params.floatsPerModifier;
  let modType = u32(modifiers[base + 0u]);

  switch (modType) {
    case MODIFIER_TYPE_WAKE: {
      return computeWake(in.worldPos, base);
    }
    case MODIFIER_TYPE_RIPPLE: {
      return computeRipple(in.worldPos, base);
    }
    default: {
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
  }
}

fn computeWake(worldPos: vec2<f32>, base: u32) -> vec4<f32> {
  let srcX = modifiers[base + 5u];
  let srcY = modifiers[base + 6u];
  let ringRadius = modifiers[base + 7u];
  let ringWidth = modifiers[base + 8u];
  let amplitude = modifiers[base + 9u];
  let turbulence = modifiers[base + 10u];

  let dx = worldPos.x - srcX;
  let dy = worldPos.y - srcY;
  let dist = sqrt(dx * dx + dy * dy);

  let distFromRing = dist - ringRadius;
  let ring = exp(-(distFromRing * distFromRing) / (ringWidth * ringWidth));

  return vec4<f32>(amplitude * ring, 0.0, 0.0, turbulence * ring);
}

fn computeRipple(worldPos: vec2<f32>, base: u32) -> vec4<f32> {
  let radius = modifiers[base + 5u];
  let intensity = modifiers[base + 6u];
  let phase = modifiers[base + 7u];

  let minX = modifiers[base + 1u];
  let minY = modifiers[base + 2u];
  let maxX = modifiers[base + 3u];
  let maxY = modifiers[base + 4u];
  let centerX = (minX + maxX) * 0.5;
  let centerY = (minY + maxY) * 0.5;
  let dx = worldPos.x - centerX;
  let dy = worldPos.y - centerY;
  let dist = sqrt(dx * dx + dy * dy);

  let ringWidth = 2.0;
  let distFromRing = abs(dist - radius);
  let falloff = max(0.0, 1.0 - distFromRing / ringWidth);
  let height = intensity * falloff * cos(phase);

  return vec4<f32>(height, 0.0, 0.0, 0.0);
}
`;

/**
 * Rasterizes water modifiers to a screen-space texture.
 */
export class ModifierRasterizer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = ModifierRasterizerUniforms.create();
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private lastModifiersBuffer: GPUBuffer | null = null;
  private initialized = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const device = this.device;

    const shaderModule = device.createShaderModule({
      code: SHADER_CODE,
      label: "Modifier Rasterizer Shader",
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
      label: "Modifier Rasterizer Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Modifier Rasterizer Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "max",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      label: "Modifier Rasterizer Pipeline",
    });

    this.uniformBuffer = device.createBuffer({
      size: ModifierRasterizerUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Modifier Rasterizer Uniforms",
    });

    this.initialized = true;
  }

  /**
   * Render modifier contributions to the modifier texture.
   *
   * @param encoder - Command encoder to record into
   * @param modifiersBuffer - Storage buffer with modifier data (from WaterResources)
   * @param modifierCount - Number of active modifiers
   * @param viewport - World-space viewport (same as water height shader)
   * @param texture - Target rgba16float 2D texture
   * @param gpuProfiler - Optional GPU profiler for timing
   */
  render(
    encoder: GPUCommandEncoder,
    modifiersBuffer: GPUBuffer,
    modifierCount: number,
    viewport: Viewport,
    texture: GPUTexture,
    gpuProfiler?: GPUProfiler | null,
  ): void {
    if (
      !this.initialized ||
      !this.pipeline ||
      !this.uniformBuffer ||
      !this.bindGroupLayout
    )
      return;

    // Update uniforms
    this.uniforms.set.viewportLeft(viewport.left);
    this.uniforms.set.viewportTop(viewport.top);
    this.uniforms.set.viewportWidth(viewport.width);
    this.uniforms.set.viewportHeight(viewport.height);
    this.uniforms.set.modifierCount(modifierCount);
    this.uniforms.set.floatsPerModifier(FLOATS_PER_MODIFIER);
    this.uniforms.uploadTo(this.uniformBuffer);

    // Rebuild bind group if buffer changed
    if (this.lastModifiersBuffer !== modifiersBuffer) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: modifiersBuffer } },
        ],
        label: "Modifier Rasterizer Bind Group",
      });
      this.lastModifiersBuffer = modifiersBuffer;
    }

    if (!this.bindGroup) return;

    const textureView = texture.createView({
      label: "Modifier Texture Render Target",
    });

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      timestampWrites: gpuProfiler?.getTimestampWrites("surface.modifiers"),
      label: "Modifier Rasterization Pass",
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);

    if (modifierCount > 0) {
      renderPass.draw(48, modifierCount); // RING_SEGMENTS * 6
    }

    renderPass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.lastModifiersBuffer = null;
    this.initialized = false;
  }
}
