/**
 * Wavefront Mesh debug mode.
 *
 * Visualizes the wavefront marching mesh for wave-terrain interaction.
 * Renders mesh triangles directly on GPU using a custom render pipeline,
 * with colors mapped from a selectable vertex attribute.
 *
 * Use [ and ] to cycle through wave sources.
 * Use { and } to cycle through active builder type (affects game systems).
 * Use V to cycle through color modes (amplitude, phase, wavefront).
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
import {
  VERTEX_FLOATS,
  type WavefrontMesh,
} from "../../wave-physics/WavefrontMesh";
import { TerrainQuery } from "../../world/terrain/TerrainQuery";
import { WaterQuery } from "../../world/water/WaterQuery";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
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
  @location(2) turbulence: f32,
  @location(3) phaseOffset: f32,
  @location(4) blendWeight: f32,
  @location(5) barycentric: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) amplitude: f32,
  @location(1) turbulence: f32,
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
  out.turbulence = in.turbulence;
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

interface CursorTriangleSample {
  amplitude: number;
  turbulence: number;
  phaseOffset: number;
  blendWeight: number;
}

interface CursorMeshSample {
  insideCoverageQuad: boolean;
  hitCount: number;
  phasorCos: number;
  phasorSin: number;
  maxTurbulence: number;
  firstHit: CursorTriangleSample | null;
}

const BARY_INSIDE_EPS = 0.001;
const DEGENERATE_TRIANGLE_EPS = 1e-10;

const COLOR_MODE_NAMES = ["Amplitude", "Phase", "Wavefront"];

export class WavefrontMeshDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private selectedWaveIndex = 0;
  private colorMode = 0;
  private waveTimeOffset = 0;

  private terrainQuery: TerrainQuery;
  private waterQuery: WaterQuery;

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

  constructor() {
    super();
    this.terrainQuery = this.addChild(
      new TerrainQuery(() => this.getCursorQueryPoint()),
    );
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.getCursorQueryPoint()),
    );
  }

  private getCursorQueryPoint() {
    if (!this.game) return [];
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return [];
    return [mouseWorldPos];
  }

  @on("add")
  async onAdd() {
    await this.initPipeline();
  }

  private async initPipeline(): Promise<void> {
    if (this.initialized) return;

    const device = this.game.getWebGPUDevice();

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
              { format: "float32", offset: 12, shaderLocation: 2 }, // turbulence
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
            format: this.game.getWebGPUPreferredFormat(),
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

    const device = this.game.getWebGPUDevice();

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
    this.uniforms.set.alpha(0.3);
    this.uniforms.set.colorMode(this.colorMode);
    this.uniforms.set.time(this.game.elapsedTime - this.waveTimeOffset);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);

    const selectedWaveIndex = this.normalizeSelectedWaveIndex(meshes.length);
    const mesh = meshes[selectedWaveIndex];
    const wireframe = this.getWireframeBuffer(mesh, device);
    this.uniforms.set.waveDirection(mesh.waveDirection);
    this.uniforms.set.wavelength(mesh.wavelength);
    this.uniforms.set.phaseRange(wireframe.totalPhaseRange);
    this.uniforms.uploadTo(this.uniformBuffer);
    renderPass.setVertexBuffer(0, wireframe.buffer);
    renderPass.draw(wireframe.vertexCount);
  }

  /** Build or retrieve a non-indexed vertex buffer with barycentric coordinates. */
  private getWireframeBuffer(
    mesh: WavefrontMesh,
    device: GPUDevice,
  ): WireframeBuffer {
    const cached = this.wireframeCache.get(mesh);
    if (cached) return cached;

    const { cpuVertexData, cpuIndexData, indexCount } = mesh;
    const floatsPerVertex = 8; // posX, posY, amplitude, turbulence, phaseOffset, blendWeight, baryU, baryV
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
      const bary = BARY_COORDS[i % BARY_COORDS.length];

      const vertex = cpuVertexData.slice(srcBase, srcBase + VERTEX_FLOATS);
      expanded.set(vertex, dstBase);
      expanded.set(bary, dstBase + VERTEX_FLOATS);

      const px = vertex[0];
      const py = vertex[1];
      const phaseOffset = vertex[4];

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

  private computeBarycentric(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): [number, number, number] | null {
    const v0x = bx - ax;
    const v0y = by - ay;
    const v1x = cx - ax;
    const v1y = cy - ay;
    const v2x = px - ax;
    const v2y = py - ay;

    const d00 = v0x * v0x + v0y * v0y;
    const d01 = v0x * v1x + v0y * v1y;
    const d11 = v1x * v1x + v1y * v1y;
    const d20 = v2x * v0x + v2y * v0y;
    const d21 = v2x * v1x + v2y * v1y;

    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < DEGENERATE_TRIANGLE_EPS) {
      return null;
    }

    const invDenom = 1 / denom;
    const v = (d11 * d20 - d01 * d21) * invDenom;
    const w = (d00 * d21 - d01 * d20) * invDenom;
    const u = 1 - v - w;
    return [u, v, w];
  }

  private isPointInTriangle(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): boolean {
    const bary = this.computeBarycentric(px, py, ax, ay, bx, by, cx, cy);
    if (!bary) return false;
    return (
      bary[0] >= -BARY_INSIDE_EPS &&
      bary[1] >= -BARY_INSIDE_EPS &&
      bary[2] >= -BARY_INSIDE_EPS
    );
  }

  private isInsideCoverageQuad(mesh: WavefrontMesh, px: number, py: number) {
    const q = mesh.coverageQuad;
    if (!q) return false;
    return (
      this.isPointInTriangle(px, py, q.x0, q.y0, q.x1, q.y1, q.x2, q.y2) ||
      this.isPointInTriangle(px, py, q.x0, q.y0, q.x2, q.y2, q.x3, q.y3)
    );
  }

  private sampleMeshAtPoint(
    mesh: WavefrontMesh,
    px: number,
    py: number,
  ): CursorMeshSample {
    const { cpuVertexData, cpuIndexData, indexCount } = mesh;

    let hitCount = 0;
    let phasorCos = 0;
    let phasorSin = 0;
    let maxTurbulence = 0;
    let firstHit: CursorTriangleSample | null = null;

    for (let i = 0; i < indexCount; i += 3) {
      const ia = cpuIndexData[i] * VERTEX_FLOATS;
      const ib = cpuIndexData[i + 1] * VERTEX_FLOATS;
      const ic = cpuIndexData[i + 2] * VERTEX_FLOATS;

      const ax = cpuVertexData[ia];
      const ay = cpuVertexData[ia + 1];
      const bx = cpuVertexData[ib];
      const by = cpuVertexData[ib + 1];
      const cx = cpuVertexData[ic];
      const cy = cpuVertexData[ic + 1];

      const bary = this.computeBarycentric(px, py, ax, ay, bx, by, cx, cy);
      if (!bary) continue;

      const [u, v, w] = bary;
      if (u < -BARY_INSIDE_EPS || v < -BARY_INSIDE_EPS || w < -BARY_INSIDE_EPS)
        continue;

      const amplitude =
        cpuVertexData[ia + 2] * u +
        cpuVertexData[ib + 2] * v +
        cpuVertexData[ic + 2] * w;
      const turbulence =
        cpuVertexData[ia + 3] * u +
        cpuVertexData[ib + 3] * v +
        cpuVertexData[ic + 3] * w;
      const phaseOffset =
        cpuVertexData[ia + 4] * u +
        cpuVertexData[ib + 4] * v +
        cpuVertexData[ic + 4] * w;
      const blendWeight =
        cpuVertexData[ia + 5] * u +
        cpuVertexData[ib + 5] * v +
        cpuVertexData[ic + 5] * w;

      const weightedAmp = amplitude * blendWeight;
      phasorCos += weightedAmp * Math.cos(phaseOffset);
      phasorSin += weightedAmp * Math.sin(phaseOffset);
      maxTurbulence = Math.max(maxTurbulence, turbulence * blendWeight);
      hitCount++;

      if (!firstHit) {
        firstHit = {
          amplitude,
          turbulence,
          phaseOffset,
          blendWeight,
        };
      }
    }

    return {
      insideCoverageQuad: this.isInsideCoverageQuad(mesh, px, py),
      hitCount,
      phasorCos,
      phasorSin,
      maxTurbulence,
      firstHit,
    };
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

  private normalizeSelectedWaveIndex(numWaves: number): number {
    this.selectedWaveIndex =
      ((this.selectedWaveIndex % numWaves) + numWaves) % numWaves;
    return this.selectedWaveIndex;
  }

  private cycleWaveIndex(direction: 1 | -1): void {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    const numWaves = wavePhysicsManager?.getActiveMeshes().length ?? 0;
    if (numWaves === 0) return;
    this.selectedWaveIndex =
      (this.normalizeSelectedWaveIndex(numWaves) + direction + numWaves) %
      numWaves;
  }

  getHudInfo(): JSX.Element | string | null {
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();
    if (!wavePhysicsManager) return "No wave physics";

    const builderType = wavePhysicsManager.getActiveBuilderType();
    const meshes = wavePhysicsManager.getActiveMeshes();
    if (meshes.length === 0) return "No active wave meshes";

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

    const controlLineStyle = {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flexWrap: "wrap" as const,
    };

    const dimStyle = { color: "#aaa", fontSize: "11px" };

    const selectedWaveIndex = this.normalizeSelectedWaveIndex(meshes.length);
    const waveLabel = `${selectedWaveIndex + 1} / ${meshes.length}`;
    const mesh = meshes[selectedWaveIndex];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <span style={controlLineStyle}>
            <span style={labelStyle}>Mode</span>
            <span
              style={chipStyle}
              onClick={() => this.cycleColorMode(1)}
              title="Click to cycle (V / Shift+V)"
            >
              {COLOR_MODE_NAMES[this.colorMode]}
            </span>
            {this.colorMode === COLOR_MODE_NAMES.indexOf("Wavefront") && (
              <span
                style={chipStyle}
                onClick={() => {
                  this.waveTimeOffset = this.game.elapsedTime;
                }}
                title="Reset wavefront animation"
              >
                Reset Wavefront
              </span>
            )}
          </span>
          <span style={controlLineStyle}>
            <span style={labelStyle}>Wave</span>
            <span
              style={chipStyle}
              onClick={() => this.cycleWaveIndex(1)}
              title="Click to cycle ([ / ])"
            >
              {waveLabel}
            </span>
          </span>
        </div>

        <div style={dimStyle}>
          <span>
            {(mesh.vertexCount / 1000).toFixed(1)}k verts {"\u03BB"}=
            {mesh.wavelength}ft dir=
            {((mesh.waveDirection * 180) / Math.PI).toFixed(0)}&deg; build=
            {mesh.buildTimeMs.toFixed(0)}ms
          </span>
        </div>
      </div>
    );
  }

  getCursorInfo(): JSX.Element | string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    const terrainHeight =
      this.terrainQuery.length > 0 ? this.terrainQuery.get(0).height : null;
    const waterHeight =
      this.waterQuery.length > 0 ? this.waterQuery.get(0).surfaceHeight : null;

    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const wavePhysicsManager = wavePhysicsResources?.getWavePhysicsManager();

    const rowStyle = {
      display: "flex",
      gap: "8px",
      alignItems: "baseline",
      flexWrap: "wrap" as const,
    };
    const labelStyle = { color: "#8fa3b8", fontSize: "11px" };
    const valueStyle = { color: "#d9e6f2", fontSize: "11px" };
    const dimStyle = { color: "#9db1c5", fontSize: "11px" };
    const heightStyle = { color: "#b9cbdd", fontSize: "11px" };

    const heightRow = (
      <span style={rowStyle}>
        <span style={labelStyle}>terrain</span>
        <span style={heightStyle}>
          {terrainHeight === null ? "--" : terrainHeight.toFixed(2)} ft
        </span>
        <span style={labelStyle}>water</span>
        <span style={heightStyle}>
          {waterHeight === null ? "--" : waterHeight.toFixed(2)} ft
        </span>
      </span>
    );

    if (!wavePhysicsManager) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={labelStyle}>Wave Mesh</span>
          <span style={valueStyle}>No wave physics</span>
          {heightRow}
        </div>
      );
    }

    const meshes = wavePhysicsManager.getActiveMeshes();
    if (meshes.length === 0) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={labelStyle}>Wave Mesh</span>
          <span style={valueStyle}>No active wave meshes</span>
          {heightRow}
        </div>
      );
    }

    const selectedWaveIndex = this.normalizeSelectedWaveIndex(meshes.length);
    const mesh = meshes[selectedWaveIndex];
    const sample = this.sampleMeshAtPoint(
      mesh,
      mouseWorldPos.x,
      mouseWorldPos.y,
    );

    if (sample.hitCount === 0) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={labelStyle}>Wave Mesh</span>
          <span style={valueStyle}>
            {sample.insideCoverageQuad
              ? "Shadow zone (coverage=1, no triangle)"
              : "No mesh coverage at cursor"}
          </span>
          {sample.insideCoverageQuad && (
            <span style={dimStyle}>pc=0.00 ps=0.00 amp=0.00 turb=0.00</span>
          )}
          {heightRow}
        </div>
      );
    }

    const amplitude = Math.hypot(sample.phasorCos, sample.phasorSin);
    const phase =
      amplitude > 0.001 ? Math.atan2(sample.phasorSin, sample.phasorCos) : 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span style={rowStyle}>
          <span style={labelStyle}>Wave Mesh</span>
          <span style={valueStyle}>
            {sample.hitCount} tri hit{sample.hitCount === 1 ? "" : "s"}
          </span>
        </span>
        <span style={rowStyle}>
          <span style={labelStyle}>amp</span>
          <span style={valueStyle}>{amplitude.toFixed(2)}</span>
          <span style={labelStyle}>phase</span>
          <span style={valueStyle}>{phase.toFixed(2)}</span>
          <span style={labelStyle}>turb</span>
          <span style={valueStyle}>{sample.maxTurbulence.toFixed(2)}</span>
        </span>
        {heightRow}
        <span style={dimStyle}>
          pc={sample.phasorCos.toFixed(2)} ps={sample.phasorSin.toFixed(2)}
        </span>
        {sample.firstHit && (
          <span style={dimStyle}>
            tri amp={sample.firstHit.amplitude.toFixed(2)} phase=
            {sample.firstHit.phaseOffset.toFixed(2)} blend=
            {sample.firstHit.blendWeight.toFixed(2)}
          </span>
        )}
      </div>
    );
  }
}
