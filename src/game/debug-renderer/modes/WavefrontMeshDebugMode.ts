/**
 * Wavefront Mesh debug mode.
 *
 * Visualizes the wavefront marching mesh for wave-terrain interaction.
 * Renders mesh triangles directly on GPU using a custom render pipeline,
 * with colors mapped from amplitude factor:
 *   red (blocked) -> yellow -> green (open ocean) -> cyan (convergence)
 *
 * Use [ and ] to cycle through wave sources.
 * Use { and } to cycle through active builder type (affects game systems).
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
import {
  VERTEX_FLOATS,
  type WavefrontMesh,
} from "../../wave-physics/WavefrontMesh";
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
  @location(2) barycentric: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) amplitude: f32,
  @location(1) barycentric: vec2<f32>,
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
  out.barycentric = in.barycentric;
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
  // Reconstruct full barycentric coordinates
  let bary = vec3<f32>(in.barycentric, 1.0 - in.barycentric.x - in.barycentric.y);

  // Distance to nearest edge in screen-space
  let minBary = min(bary.x, min(bary.y, bary.z));
  let fw = fwidth(minBary);
  let edge = smoothstep(0.0, fw * 1.5, minBary);

  let fillColor = amplitudeToColor(in.amplitude);
  let edgeColor = vec3<f32>(0.0, 0.0, 0.0);
  let color = mix(edgeColor, fillColor, edge);
  return vec4<f32>(color, params.alpha);
}
`;

/** Barycentric coords for each vertex position within a triangle */
const BARY_COORDS = [
  [1, 0], // vertex 0: (1, 0) -> third = 0
  [0, 1], // vertex 1: (0, 1) -> third = 0
  [0, 0], // vertex 2: (0, 0) -> third = 1
];

interface WireframeBuffer {
  buffer: GPUBuffer;
  vertexCount: number;
}

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

  /** Cached wireframe buffers keyed by source mesh */
  private wireframeCache = new Map<WavefrontMesh, WireframeBuffer>();

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
            arrayStride: 20, // 5 floats x 4 bytes
            attributes: [
              { format: "float32x2", offset: 0, shaderLocation: 0 }, // position
              { format: "float32", offset: 8, shaderLocation: 1 }, // amplitude
              { format: "float32x2", offset: 12, shaderLocation: 2 }, // barycentric
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

    const meshes = wavePhysicsManager.getActiveMeshes();
    if (meshes.length === 0) return;

    const device = getWebGPU().device;

    // Evict wireframe buffers for meshes that no longer exist
    for (const [mesh, cached] of this.wireframeCache) {
      if (!meshes.includes(mesh)) {
        cached.buffer.destroy();
        this.wireframeCache.delete(mesh);
      }
    }

    const renderer = this.game.getRenderer();
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    // Camera world->pixel matrix (set by setLayer for windViz)
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

      const wireframe = this.getWireframeBuffer(meshes[w], device);
      renderPass.setVertexBuffer(0, wireframe.buffer);
      renderPass.draw(wireframe.vertexCount);
    }
  }

  /** Build or retrieve a non-indexed vertex buffer with barycentric coordinates. */
  private getWireframeBuffer(
    mesh: WavefrontMesh,
    device: GPUDevice,
  ): WireframeBuffer {
    const cached = this.wireframeCache.get(mesh);
    if (cached) return cached;

    const { cpuVertexData, cpuIndexData, indexCount } = mesh;
    const floatsPerVertex = 5; // posX, posY, amplitude, baryU, baryV
    const expanded = new Float32Array(indexCount * floatsPerVertex);

    for (let i = 0; i < indexCount; i++) {
      const srcBase = cpuIndexData[i] * VERTEX_FLOATS;
      const dstBase = i * floatsPerVertex;
      const bary = BARY_COORDS[i % 3];

      expanded[dstBase] = cpuVertexData[srcBase]; // posX
      expanded[dstBase + 1] = cpuVertexData[srcBase + 1]; // posY
      expanded[dstBase + 2] = cpuVertexData[srcBase + 2]; // amplitude
      expanded[dstBase + 3] = bary[0]; // baryU
      expanded[dstBase + 4] = bary[1]; // baryV
    }

    const buffer = device.createBuffer({
      size: expanded.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Wavefront Debug Wireframe",
    });
    device.queue.writeBuffer(buffer, 0, expanded);

    const entry: WireframeBuffer = { buffer, vertexCount: indexCount };
    this.wireframeCache.set(mesh, entry);
    return entry;
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]): void {
    if (key === "BracketLeft" || key === "BracketRight") {
      if (event.shiftKey) {
        // Shift+[ = { / Shift+] = } — cycle builder types
        this.cycleBuilderType(key === "BracketRight");
      } else {
        // [ ] — cycle wave sources
        const waterResources =
          this.game.entities.tryGetSingleton(WaterResources);
        const numWaves = waterResources?.getNumWaves() ?? 1;

        if (key === "BracketLeft") {
          this.selectedWaveIndex =
            this.selectedWaveIndex <= -1
              ? numWaves - 1
              : this.selectedWaveIndex - 1;
        } else {
          this.selectedWaveIndex =
            this.selectedWaveIndex >= numWaves - 1
              ? -1
              : this.selectedWaveIndex + 1;
        }
      }
    }
  }

  private cycleBuilderType(forward: boolean): void {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    if (!wavePhysicsManager) return;

    const availableTypes = wavePhysicsManager.getActiveBuilderTypes();
    if (availableTypes.length <= 1) return;

    const currentType = wavePhysicsManager.getActiveBuilderType();
    const currentIdx = availableTypes.indexOf(currentType);
    const nextIdx = forward
      ? (currentIdx + 1) % availableTypes.length
      : (currentIdx - 1 + availableTypes.length) % availableTypes.length;
    wavePhysicsManager.setActiveBuilderType(availableTypes[nextIdx]);
  }

  @on("destroy")
  onDestroy(): void {
    this.uniformBuffer?.destroy();
    for (const cached of this.wireframeCache.values()) {
      cached.buffer.destroy();
    }
    this.wireframeCache.clear();
  }

  getModeName(): string {
    return "Wavefront Mesh";
  }

  getHudInfo(): string | null {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    if (!wavePhysicsManager) return "No wave physics";

    const builderType = wavePhysicsManager.getActiveBuilderType();
    const meshes = wavePhysicsManager.getActiveMeshes();
    if (meshes.length === 0) return `[${builderType}] No wavefront meshes`;

    if (this.selectedWaveIndex < 0) {
      const totalVerts = meshes.reduce((s, m) => s + m.vertexCount, 0);
      return (
        `[${builderType}] All waves (${meshes.length} meshes, ` +
        `${(totalVerts / 1000).toFixed(1)}k verts) [/] wave {/} builder`
      );
    }

    const mesh = meshes[this.selectedWaveIndex];
    if (!mesh)
      return `[${builderType}] Wave ${this.selectedWaveIndex}: not found`;

    const dirDeg = ((mesh.waveDirection * 180) / Math.PI).toFixed(0);
    return (
      `[${builderType}] Wave ${this.selectedWaveIndex}: ` +
      `${(mesh.vertexCount / 1000).toFixed(1)}k verts, ` +
      `\u03BB=${mesh.wavelength}ft, dir=${dirDeg}\u00B0, ` +
      `build ${mesh.buildTimeMs.toFixed(0)}ms`
    );
  }
}
