/**
 * Wavefront Mesh debug mode.
 *
 * Visualizes the wavefront marching mesh for wave-terrain interaction.
 * Renders mesh triangles directly on GPU using a custom render pipeline,
 * with colors mapped from amplitude factor:
 *   red (blocked) → yellow → green (open ocean) → cyan (convergence)
 *
 * Use [ and ] to cycle through wave sources.
 */

import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  type UniformInstance,
} from "../../../core/graphics/UniformStruct";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { WaterResources } from "../../world/water/WaterResources";
import { DebugRenderMode } from "./DebugRenderMode";

const WavefrontDebugUniforms = defineUniformStruct("WavefrontDebugParams", {
  cameraMatrix: mat3x3,
  screenWidth: f32,
  screenHeight: f32,
  alpha: f32,
});

const SHADER_CODE = /*wgsl*/ `
struct WavefrontDebugParams {
  cameraMatrix0: vec4<f32>,
  cameraMatrix1: vec4<f32>,
  cameraMatrix2: vec4<f32>,
  screenWidth: f32,
  screenHeight: f32,
  alpha: f32,
}

@group(0) @binding(0) var<uniform> params: WavefrontDebugParams;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) amplitude: f32,
  @location(2) dirOffset: f32,
  @location(3) phaseOffset: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) amplitude: f32,
}

fn getCameraMatrix() -> mat3x3<f32> {
  return mat3x3<f32>(
    params.cameraMatrix0.xyz,
    params.cameraMatrix1.xyz,
    params.cameraMatrix2.xyz
  );
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let cameraMatrix = getCameraMatrix();
  let pixelPos = cameraMatrix * vec3<f32>(in.position, 1.0);
  let clipX = pixelPos.x * 2.0 / params.screenWidth - 1.0;
  let clipY = pixelPos.y * 2.0 / params.screenHeight - 1.0;

  var out: VertexOutput;
  out.position = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.amplitude = in.amplitude;
  return out;
}

fn amplitudeToColor(amp: f32) -> vec3<f32> {
  if (amp <= 0.0) { return vec3<f32>(0.3, 0.0, 0.0); }
  if (amp <= 0.5) {
    let t = amp / 0.5;
    return vec3<f32>(1.0, t, 0.0);
  }
  if (amp <= 1.0) {
    let t = (amp - 0.5) / 0.5;
    return vec3<f32>(1.0 - t, 1.0, 0.0);
  }
  let t = min((amp - 1.0) / 0.5, 1.0);
  return vec3<f32>(0.0, 1.0, t);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let color = amplitudeToColor(in.amplitude);
  return vec4<f32>(color, params.alpha);
}
`;

export class WavefrontMeshDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private selectedWaveIndex = -1; // -1 = show all

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms: UniformInstance<
    typeof WavefrontDebugUniforms.fields
  > | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private initialized = false;

  @on("add")
  async onAdd() {
    await this.initPipeline();
  }

  private async initPipeline(): Promise<void> {
    if (this.initialized) return;

    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: SHADER_CODE,
      label: "Wavefront Debug Shader",
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Wavefront Debug Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wavefront Debug Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 20, // 5 floats × 4 bytes
            attributes: [
              { format: "float32x2", offset: 0, shaderLocation: 0 }, // position
              { format: "float32", offset: 8, shaderLocation: 1 }, // amplitude
              { format: "float32", offset: 12, shaderLocation: 2 }, // dirOffset
              { format: "float32", offset: 16, shaderLocation: 3 }, // phaseOffset
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: getWebGPU().preferredFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      label: "Wavefront Debug Pipeline",
    });

    this.uniformBuffer = device.createBuffer({
      size: WavefrontDebugUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wavefront Debug Uniforms",
    });

    this.uniforms = WavefrontDebugUniforms.create();

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
      label: "Wavefront Debug Bind Group",
    });

    this.initialized = true;
  }

  @on("render")
  onRender(_event: GameEventMap["render"]): void {
    if (
      !this.initialized ||
      !this.pipeline ||
      !this.bindGroup ||
      !this.uniformBuffer ||
      !this.uniforms
    )
      return;

    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();

    if (!wavePhysicsManager || !wavePhysicsManager.isInitialized()) return;

    const meshes = wavePhysicsManager.getMeshes();
    if (meshes.length === 0) return;

    const renderer = this.game.getRenderer();
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Camera world→pixel matrix (set by setLayer for windViz)
    const cameraMatrix = renderer.getTransform();
    const width = renderer.getWidth();
    const height = renderer.getHeight();

    this.uniforms.set.cameraMatrix(cameraMatrix);
    this.uniforms.set.screenWidth(width);
    this.uniforms.set.screenHeight(height);
    this.uniforms.set.alpha(0.7);
    this.uniforms.uploadTo(this.uniformBuffer);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);

    for (let w = 0; w < meshes.length; w++) {
      if (this.selectedWaveIndex >= 0 && this.selectedWaveIndex !== w) continue;

      const mesh = meshes[w];
      const indexCount = (mesh.numSteps - 1) * (mesh.vertexCount - 1) * 6;

      renderPass.setVertexBuffer(0, mesh.vertexBuffer);
      renderPass.setIndexBuffer(mesh.indexBuffer, "uint32");
      renderPass.drawIndexed(indexCount);
    }
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]): void {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const numWaves = waterResources?.getNumWaves() ?? 1;

    if (key === "BracketLeft") {
      this.selectedWaveIndex =
        this.selectedWaveIndex <= -1
          ? numWaves - 1
          : this.selectedWaveIndex - 1;
    } else if (key === "BracketRight") {
      this.selectedWaveIndex =
        this.selectedWaveIndex >= numWaves - 1
          ? -1
          : this.selectedWaveIndex + 1;
    }
  }

  @on("destroy")
  onDestroy(): void {
    this.uniformBuffer?.destroy();
  }

  getModeName(): string {
    return "Wavefront Mesh";
  }

  getHudInfo(): string | null {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    if (!wavePhysicsManager) return "No wave physics";

    const meshes = wavePhysicsManager.getMeshes();
    if (meshes.length === 0) return "No wavefront meshes";

    if (this.selectedWaveIndex < 0) {
      return `All waves (${meshes.length} meshes) [/] to cycle`;
    }

    const mesh = meshes[this.selectedWaveIndex];
    if (!mesh) return `Wave ${this.selectedWaveIndex}: not found`;

    const dirDeg = (
      (Math.atan2(mesh.waveDirY, mesh.waveDirX) * 180) /
      Math.PI
    ).toFixed(0);
    return (
      `Wave ${this.selectedWaveIndex}: ` +
      `${mesh.vertexCount} verts x ${mesh.numSteps} steps, ` +
      `\u03BB=${mesh.wavelength}ft, dir=${dirDeg}\u00B0`
    );
  }
}
