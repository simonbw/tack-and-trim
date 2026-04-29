import type { Matrix3 } from "../../core/graphics/Matrix3";
import {
  defineUniformStruct,
  f32,
  mat3x3,
} from "../../core/graphics/UniformStruct";
import { validateShaderModuleCompilation } from "../../core/graphics/webgpu/WebGPUDevice";
import type { Light } from "./Light";

/**
 * Rasterizes Light entities into the screen-space lights texture.
 *
 * One quad per light, sized to the light's world-space radius and centered
 * on its position. Fragments compute a smooth radial falloff and accumulate
 * additively into rgba16float, so overlapping lights brighten naturally.
 */

const RasterizerUniforms = defineUniformStruct("LightsParams", {
  // Maps world-space coordinates directly into clip space for the lights
  // target. Computed CPU-side as `viewMatrix * cameraMatrix`.
  worldToClip: mat3x3,
  // Wall time in seconds, only used to decorrelate the per-pixel dither
  // from frame to frame so it reads as TV static / film grain rather than
  // a fixed dirty-window pattern.
  time: f32,
});

const SHADER_CODE = /*wgsl*/ `
struct LightsParams {
  worldToClip: mat3x3<f32>,
  time: f32,
}

@group(0) @binding(0) var<uniform> params: LightsParams;

struct VertexInput {
  @location(0) cornerOffset: vec2<f32>,
  @location(1) center: vec2<f32>,
  @location(2) radius: f32,
  @location(3) color: vec3<f32>,
  @location(4) intensity: f32,
  @location(5) halfDistance: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) localOffset: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) intensity: f32,
  @location(3) halfDistanceSqRatio: f32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let worldPos = in.center + in.cornerOffset * in.radius;
  let clip = (params.worldToClip * vec3<f32>(worldPos, 1.0)).xy;
  var out: VertexOutput;
  out.position = vec4<f32>(clip, 0.0, 1.0);
  out.localOffset = in.cornerOffset;
  out.color = in.color;
  out.intensity = in.intensity;
  // Pass (radius / halfDistance)^2 so the fragment can use the cheaper
  // normalized form 1 / (1 + k * d_norm^2) instead of recomputing the
  // ratio per fragment.
  let ratio = in.radius / max(in.halfDistance, 1e-3);
  out.halfDistanceSqRatio = ratio * ratio;
  return out;
}

// Cheap screen-space hash, [0, 1).
fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let d2 = dot(in.localOffset, in.localOffset);
  if (d2 >= 1.0) {
    discard;
  }
  // Physically-inspired falloff: a soft 1/r^2 core multiplied by a smooth
  // radius window so the contribution reaches zero exactly at r = radius
  // (no hard cliff, no infinite tail).
  //
  //   invSq  = 1 / (1 + (d / halfDistance)^2)
  //          == 1 / (1 + k * d_norm^2) where k = (radius/halfDistance)^2
  //     A real point light's 1/(1+r^2) curve in absolute units --
  //     half-brightness happens exactly at d = halfDistance.
  //   window = (1 - d_norm^2)^2
  //     Smooth cutoff so the contribution lands at zero at the radius.
  //
  // d_norm in [0, 1] is the normalized distance (1 = the light's radius).
  let invSq = 1.0 / (1.0 + in.halfDistanceSqRatio * d2);
  let edge = 1.0 - d2;
  let window = edge * edge;
  // Per-pixel dither: ~+/-10% multiplier on the contribution. Reseeded
  // every frame from params.time so each frame draws an independent
  // noise pattern -- reads as TV static / film grain in motion rather
  // than a fixed dirty-window pattern. Also breaks up 8-bit banding
  // when the LDR final color is quantized.
  let noiseSeed = floor(in.position.xy) + vec2<f32>(params.time * 71.0, params.time * 113.0);
  let noise = hash21(noiseSeed) - 0.5;
  let dither = 1.0 + noise * 0.2;
  let attenuation = invSq * window * in.intensity * dither;
  return vec4<f32>(in.color * attenuation, attenuation);
}
`;

// 6 vertices per light × 10 floats per vertex (cornerOffset 2 + center 2 +
// radius 1 + color 3 + intensity 1 + halfDistance 1).
const FLOATS_PER_VERTEX = 10;
const VERTICES_PER_LIGHT = 6;
const FLOATS_PER_LIGHT = FLOATS_PER_VERTEX * VERTICES_PER_LIGHT;
const VERTEX_STRIDE = FLOATS_PER_VERTEX * 4;

// Unit-quad corner offsets covering the (-1,-1)..(1,1) square as two
// triangles. Stamped into every per-vertex slot the rasterizer writes.
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export class LightsRasterizer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = RasterizerUniforms.create();
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;

  // CPU-side scratch + a growable GPU vertex buffer.
  private cpuVerts: Float32Array = new Float32Array(0);
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCapacityLights = 0;

  private initialized = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const device = this.device;

    const shaderModule = device.createShaderModule({
      code: SHADER_CODE,
      label: "Lights Rasterizer Shader",
    });
    await validateShaderModuleCompilation(
      shaderModule,
      SHADER_CODE,
      "Lights Rasterizer Shader",
    );

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Lights Rasterizer Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Lights Rasterizer Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            attributes: [
              { format: "float32x2", offset: 0, shaderLocation: 0 }, // cornerOffset
              { format: "float32x2", offset: 8, shaderLocation: 1 }, // center
              { format: "float32", offset: 16, shaderLocation: 2 }, // radius
              { format: "float32x3", offset: 20, shaderLocation: 3 }, // color
              { format: "float32", offset: 32, shaderLocation: 4 }, // intensity
              { format: "float32", offset: 36, shaderLocation: 5 }, // halfDistance
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      label: "Lights Rasterizer Pipeline",
    });

    this.uniformBuffer = device.createBuffer({
      size: RasterizerUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Lights Rasterizer Uniforms",
    });

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      label: "Lights Rasterizer Bind Group",
    });

    this.initialized = true;
  }

  /**
   * Rasterize all lights into `targetView`. Always opens a new render pass
   * (clear=load: false → clear to (0,0,0,0)) so the texture is fresh each
   * frame even when there are zero lights.
   */
  render(
    encoder: GPUCommandEncoder,
    lights: readonly Light[],
    worldToClip: Matrix3,
    targetView: GPUTextureView,
    time: number,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroup) return;

    this.uniforms.set.worldToClip(worldToClip);
    this.uniforms.set.time(time);
    this.uniforms.uploadTo(this.uniformBuffer!);

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      label: "Lights Rasterize",
    });

    if (lights.length > 0) {
      this.ensureVertexCapacity(lights.length);
      this.writeVertices(lights);
      this.device.queue.writeBuffer(
        this.vertexBuffer!,
        0,
        this.cpuVerts.buffer,
        this.cpuVerts.byteOffset,
        lights.length * FLOATS_PER_LIGHT * 4,
      );

      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.vertexBuffer!);
      pass.draw(VERTICES_PER_LIGHT * lights.length);
    }

    pass.end();
  }

  private ensureVertexCapacity(numLights: number): void {
    if (numLights <= this.vertexCapacityLights && this.vertexBuffer) return;
    const newCapacity = Math.max(numLights, this.vertexCapacityLights * 2, 16);
    this.vertexBuffer?.destroy();
    this.vertexBuffer = this.device.createBuffer({
      size: newCapacity * FLOATS_PER_LIGHT * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Lights Rasterizer Vertex Buffer",
    });
    this.cpuVerts = new Float32Array(newCapacity * FLOATS_PER_LIGHT);
    this.vertexCapacityLights = newCapacity;
  }

  private writeVertices(lights: readonly Light[]): void {
    const out = this.cpuVerts;
    let o = 0;
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i];
      const cx = light.position[0];
      const cy = light.position[1];
      const r = light.radius;
      const [cr, cg, cb] = light.color;
      const intensity = light.intensity;
      const halfDistance = light.halfDistance;
      for (let v = 0; v < VERTICES_PER_LIGHT; v++) {
        const [ox, oy] = CORNER_OFFSETS[v];
        out[o++] = ox;
        out[o++] = oy;
        out[o++] = cx;
        out[o++] = cy;
        out[o++] = r;
        out[o++] = cr;
        out[o++] = cg;
        out[o++] = cb;
        out[o++] = intensity;
        out[o++] = halfDistance;
      }
    }
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}
