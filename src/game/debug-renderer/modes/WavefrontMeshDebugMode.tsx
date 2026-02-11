/**
 * Wavefront Mesh debug mode.
 *
 * Visualizes the wavefront marching mesh for wave-terrain interaction.
 * Renders mesh triangles directly on GPU using a custom render pipeline,
 * with colors mapped from a selectable vertex attribute.
 *
 * Use [ and ] to cycle through wave sources.
 * Use { and } to cycle through active builder type (affects game systems).
 * Use V to cycle through color modes (amplitude, phase, direction, blend weight).
 */

import { type JSX } from "preact";
import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import {
  defineUniformStruct,
  f32,
  mat3x3,
  type UniformInstance,
} from "../../../core/graphics/UniformStruct";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { profiler } from "../../../core/util/Profiler";
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
  colorMode: f32,
  waveDirection: f32,
  wavelength: f32,
  time: f32,
  phaseRange: f32,
});

const SHADER_CODE = /*wgsl*/ `
const GRAVITY = 32.174;
const TWO_PI = 6.283185;

struct WavefrontDebugParams {
  cameraMatrix0: vec4<f32>,
  cameraMatrix1: vec4<f32>,
  cameraMatrix2: vec4<f32>,
  screenWidth: f32,
  screenHeight: f32,
  alpha: f32,
  colorMode: f32,
  waveDirection: f32,
  wavelength: f32,
  time: f32,
  phaseRange: f32,
}

@group(0) @binding(0) var<uniform> params: WavefrontDebugParams;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) amplitude: f32,
  @location(2) directionOffset: f32,
  @location(3) phaseOffset: f32,
  @location(4) blendWeight: f32,
  @location(5) barycentric: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) amplitude: f32,
  @location(1) directionOffset: f32,
  @location(2) phaseOffset: f32,
  @location(3) blendWeight: f32,
  @location(4) barycentric: vec2<f32>,
  @location(5) worldPos: vec2<f32>,
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
  out.directionOffset = in.directionOffset;
  out.phaseOffset = in.phaseOffset;
  out.blendWeight = in.blendWeight;
  out.barycentric = in.barycentric;
  out.worldPos = in.position;
  return out;
}

// Mode 0: Amplitude — red (blocked) -> yellow -> green (open) -> cyan (convergence)
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

// Mode 1: Phase offset — cyclic rainbow
fn phaseToColor(phase: f32) -> vec3<f32> {
  let t = fract(phase / TWO_PI);
  let r = abs(t * 6.0 - 3.0) - 1.0;
  let g = 2.0 - abs(t * 6.0 - 2.0);
  let b = 2.0 - abs(t * 6.0 - 4.0);
  return saturate(vec3<f32>(r, g, b));
}

// Mode 2: Single animated wavefront band sweeping across the mesh
fn wavefrontBand(worldPos: vec2<f32>, phaseOffset: f32) -> f32 {
  let k = TWO_PI / params.wavelength;
  let omega = sqrt(GRAVITY * k);
  let dirUnit = vec2<f32>(cos(params.waveDirection), sin(params.waveDirection));
  let totalPhase = k * dot(worldPos, dirUnit) + phaseOffset;

  // Wrap (totalPhase - omega*time*speedMult) into [0, phaseRange) for a single band
  let diff = totalPhase - omega * params.time * 20.0;
  let range = params.phaseRange;
  let wrapped = diff - floor(diff / range) * range;

  // Highlight near wrapped ≈ 0 (with wrapping at range boundary)
  let distToBand = min(wrapped, range - wrapped);
  let bandWidth = range * 0.003;
  return step(distToBand, bandWidth);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Reconstruct full barycentric coordinates
  let bary = vec3<f32>(in.barycentric, 1.0 - in.barycentric.x - in.barycentric.y);

  // Distance to nearest edge in screen-space
  let minBary = min(bary.x, min(bary.y, bary.z));
  let fw = fwidth(minBary);
  let edge = smoothstep(0.0, fw * 1.5, minBary);

  let mode = u32(params.colorMode);

  // Wavefront mode: transparent background, band alpha varies with amplitude
  if (mode == 2u) {
    let band = wavefrontBand(in.worldPos, in.phaseOffset);
    if (band < 0.5) { discard; }
    let amp = clamp(in.amplitude, 0.0, 1.5);
    let a = mix(0.15, 1.0, amp);
    return vec4<f32>(0.2, 0.7, 1.0, a);
  }

  var fillColor: vec3<f32>;
  switch (mode) {
    case 1u: { fillColor = phaseToColor(in.phaseOffset); }
    default: { fillColor = amplitudeToColor(in.amplitude); }
  }

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
  /** Range of totalPhase values across the mesh, for single-band wrapping */
  totalPhaseRange: number;
}

const COLOR_MODE_NAMES = ["Amplitude", "Phase", "Wavefront"];

export class WavefrontMeshDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private selectedWaveIndex = -1; // -1 = show all
  private colorMode = 0;
  private waveTimeOffset = 0;

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
            arrayStride: 32, // 8 floats x 4 bytes
            attributes: [
              { format: "float32x2", offset: 0, shaderLocation: 0 }, // position
              { format: "float32", offset: 8, shaderLocation: 1 }, // amplitude
              { format: "float32", offset: 12, shaderLocation: 2 }, // directionOffset
              { format: "float32", offset: 16, shaderLocation: 3 }, // phaseOffset
              { format: "float32", offset: 20, shaderLocation: 4 }, // blendWeight
              { format: "float32x2", offset: 24, shaderLocation: 5 }, // barycentric
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
    this.uniforms.set.colorMode(this.colorMode);
    this.uniforms.set.time(this.game.elapsedTime - this.waveTimeOffset);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);

    for (let w = 0; w < meshes.length; w++) {
      if (this.selectedWaveIndex >= 0 && this.selectedWaveIndex !== w) continue;

      const mesh = meshes[w];
      const wireframe = this.getWireframeBuffer(mesh, device);
      this.uniforms.set.waveDirection(mesh.waveDirection);
      this.uniforms.set.wavelength(mesh.wavelength);
      this.uniforms.set.phaseRange(wireframe.totalPhaseRange);
      this.uniforms.uploadTo(this.uniformBuffer);
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
    const floatsPerVertex = 8; // posX, posY, amplitude, dirOffset, phaseOffset, blendWeight, baryU, baryV
    const expanded = new Float32Array(indexCount * floatsPerVertex);

    // Compute totalPhase range for single-band wavefront mode
    const k = (2 * Math.PI) / mesh.wavelength;
    const dirCos = Math.cos(mesh.waveDirection);
    const dirSin = Math.sin(mesh.waveDirection);
    let minPhase = Infinity;
    let maxPhase = -Infinity;

    for (let i = 0; i < indexCount; i++) {
      const srcBase = cpuIndexData[i] * VERTEX_FLOATS;
      const dstBase = i * floatsPerVertex;
      const bary = BARY_COORDS[i % 3];

      const px = cpuVertexData[srcBase];
      const py = cpuVertexData[srcBase + 1];
      const phaseOffset = cpuVertexData[srcBase + 4];

      expanded[dstBase] = px;
      expanded[dstBase + 1] = py;
      expanded[dstBase + 2] = cpuVertexData[srcBase + 2]; // amplitude
      expanded[dstBase + 3] = cpuVertexData[srcBase + 3]; // directionOffset
      expanded[dstBase + 4] = phaseOffset;
      expanded[dstBase + 5] = cpuVertexData[srcBase + 5]; // blendWeight
      expanded[dstBase + 6] = bary[0]; // baryU
      expanded[dstBase + 7] = bary[1]; // baryV

      const totalPhase = k * (px * dirCos + py * dirSin) + phaseOffset;
      minPhase = Math.min(minPhase, totalPhase);
      maxPhase = Math.max(maxPhase, totalPhase);
    }

    const buffer = device.createBuffer({
      size: expanded.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Wavefront Debug Wireframe",
    });
    device.queue.writeBuffer(buffer, 0, expanded);

    const totalPhaseRange = maxPhase - minPhase;
    const entry: WireframeBuffer = {
      buffer,
      vertexCount: indexCount,
      totalPhaseRange,
    };
    this.wireframeCache.set(mesh, entry);
    return entry;
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]): void {
    if (key === "BracketLeft" || key === "BracketRight") {
      const dir = key === "BracketRight" ? 1 : -1;
      if (event.shiftKey) {
        this.cycleBuilderType(dir === 1);
      } else {
        this.cycleWaveIndex(dir);
      }
    } else if (key === "KeyV") {
      this.cycleColorMode(event.shiftKey ? -1 : 1);
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

  private cycleColorMode(direction: 1 | -1): void {
    const n = COLOR_MODE_NAMES.length;
    this.colorMode = (this.colorMode + direction + n) % n;
  }

  private cycleWaveIndex(direction: 1 | -1): void {
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    const numWaves = waterResources?.getNumWaves() ?? 1;
    // Range: -1 (all) through numWaves-1
    const total = numWaves + 1;
    this.selectedWaveIndex =
      ((this.selectedWaveIndex + 1 + direction + total) % total) - 1;
  }

  getHudInfo(): JSX.Element | string | null {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    if (!wavePhysicsManager) return "No wave physics";

    const builderType = wavePhysicsManager.getActiveBuilderType();
    const meshes = wavePhysicsManager.getActiveMeshes();

    const chipStyle = {
      cursor: "pointer",
      padding: "1px 6px",
      borderRadius: "3px",
      background: "rgba(255,255,255,0.1)",
      border: "1px solid rgba(255,255,255,0.2)",
    };

    const labelStyle = {
      color: "#888",
      fontSize: "11px",
    };

    const dimStyle = { color: "#aaa", fontSize: "11px" };
    const monoStyle = { fontFamily: "monospace", fontSize: "11px" };

    const waveLabel =
      this.selectedWaveIndex < 0
        ? `All (${meshes.length})`
        : `${this.selectedWaveIndex + 1} / ${meshes.length}`;

    const mesh =
      this.selectedWaveIndex >= 0 ? meshes[this.selectedWaveIndex] : undefined;

    const totalVerts =
      this.selectedWaveIndex < 0
        ? meshes.reduce((s, m) => s + m.vertexCount, 0)
        : (mesh?.vertexCount ?? 0);

    // GPU timing
    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const gpu = gpuProfiler?.getAllMs();

    // CPU timing — find wave-related profiler entries
    const cpuStats = profiler.getStats();
    const cpuEntries: Array<{ label: string; ms: number }> = [];
    for (const stat of cpuStats) {
      if (
        stat.msPerFrame > 0.01 &&
        (stat.label.includes("wave") ||
          stat.label.includes("Wave") ||
          stat.label.includes("mesh") ||
          stat.label.includes("Mesh") ||
          stat.label.includes("rasteriz") ||
          stat.label.includes("Rasteriz") ||
          stat.label.includes("coastline") ||
          stat.label.includes("Coastline"))
      ) {
        cpuEntries.push({ label: stat.shortLabel, ms: stat.msPerFrame });
      }
    }

    const fmtMs = (ms: number) => ms.toFixed(2);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span>
            <span style={labelStyle}>Color </span>
            <span
              style={chipStyle}
              onClick={() => this.cycleColorMode(1)}
              title="Click to cycle (V / Shift+V)"
            >
              {COLOR_MODE_NAMES[this.colorMode]}
            </span>
          </span>
          <span>
            <span style={labelStyle}>Wave </span>
            <span
              style={chipStyle}
              onClick={() => this.cycleWaveIndex(1)}
              title="Click to cycle ([ / ])"
            >
              {waveLabel}
            </span>
          </span>
          <span>
            <span style={labelStyle}>Builder </span>
            <span
              style={chipStyle}
              onClick={() => this.cycleBuilderType(true)}
              title="Click to cycle ({ / })"
            >
              {builderType}
            </span>
          </span>
          {this.colorMode === COLOR_MODE_NAMES.indexOf("Wavefront") && (
            <span
              style={chipStyle}
              onClick={() => {
                this.waveTimeOffset = this.game.elapsedTime;
              }}
              title="Reset wavefront animation"
            >
              Reset
            </span>
          )}
        </div>

        <div style={dimStyle}>
          {mesh ? (
            <span>
              {(mesh.vertexCount / 1000).toFixed(1)}k verts {"\u03BB"}=
              {mesh.wavelength}ft dir=
              {((mesh.waveDirection * 180) / Math.PI).toFixed(0)}&deg; build=
              {mesh.buildTimeMs.toFixed(0)}ms
            </span>
          ) : (
            <span>{(totalVerts / 1000).toFixed(1)}k verts total</span>
          )}
        </div>

        {gpu && (
          <div style={monoStyle}>
            <div style={labelStyle}>GPU</div>
            <div>
              surface.water {fmtMs(gpu["surface.water"])}ms &nbsp;
              surface.terrain {fmtMs(gpu["surface.terrain"])}ms
            </div>
            <div>
              query.water {fmtMs(gpu["query.water"])}ms &nbsp; query.copy{" "}
              {fmtMs(gpu["query.copy"])}ms
            </div>
          </div>
        )}

        {cpuEntries.length > 0 && (
          <div style={monoStyle}>
            <div style={labelStyle}>CPU</div>
            {cpuEntries.map((e) => (
              <div key={e.label}>
                {e.label} {fmtMs(e.ms)}ms
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
}
