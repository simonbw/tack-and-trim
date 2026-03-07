/**
 * Wind Mesh debug mode.
 *
 * Visualizes the wind mesh overlay (uniform grid with wind attributes).
 * Renders mesh triangles directly on GPU using a custom render pipeline,
 * with colors mapped from a selectable vertex attribute.
 *
 * Use V to cycle through color modes (Speed Factor, Direction Offset, Turbulence).
 * Use B to cycle through wind sources.
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
import { validateShaderModuleCompilation } from "../../../core/graphics/webgpu/WebGPUDevice";
import type {
  WindMeshFileBundle,
  WindMeshSourceData,
} from "../../../pipeline/mesh-building/WindmeshFile";
import { WindResources } from "../../world/wind/WindResources";
import { DebugRenderMode } from "./DebugRenderMode";

/** Floats per vertex in WindMeshSourceData: posX, posY, speedFactor, directionOffset, turbulence */
const WIND_VERTEX_FLOATS = 5;

const WindMeshDebugUniforms = defineUniformStruct("WindMeshDebugParams", {
  cameraMatrix: mat3x3,
  screenWidth: f32,
  screenHeight: f32,
  alpha: f32,
  colorMode: f32,
});

const SHADER_CODE = /*wgsl*/ `
const TWO_PI = 6.283185;

struct WindMeshDebugParams {
  cameraMatrix0: vec4<f32>,
  cameraMatrix1: vec4<f32>,
  cameraMatrix2: vec4<f32>,
  screenWidth: f32,
  screenHeight: f32,
  alpha: f32,
  colorMode: f32,
}

@group(0) @binding(0) var<uniform> params: WindMeshDebugParams;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) speedFactor: f32,
  @location(2) directionOffset: f32,
  @location(3) turbulence: f32,
  @location(4) barycentric: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) speedFactor: f32,
  @location(1) directionOffset: f32,
  @location(2) turbulence: f32,
  @location(3) barycentric: vec2<f32>,
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
  out.speedFactor = in.speedFactor;
  out.directionOffset = in.directionOffset;
  out.turbulence = in.turbulence;
  out.barycentric = in.barycentric;
  return out;
}

// Mode 0: Speed Factor — red (blocked) -> yellow -> green (neutral) -> cyan (accelerated)
fn speedFactorToColor(sf: f32) -> vec3<f32> {
  if (sf <= 0.0) { return vec3<f32>(0.3, 0.0, 0.0); }
  if (sf <= 0.5) {
    let t = sf / 0.5;
    return vec3<f32>(1.0, t, 0.0);
  }
  if (sf <= 1.0) {
    let t = (sf - 0.5) / 0.5;
    return vec3<f32>(1.0 - t, 1.0, 0.0);
  }
  let t = min((sf - 1.0) / 0.5, 1.0);
  return vec3<f32>(0.0, 1.0, t);
}

// Mode 1: Direction Offset — cyclic rainbow
fn directionOffsetToColor(offset: f32) -> vec3<f32> {
  let t = fract(offset / TWO_PI);
  let r = abs(t * 6.0 - 3.0) - 1.0;
  let g = 2.0 - abs(t * 6.0 - 2.0);
  let b = 2.0 - abs(t * 6.0 - 4.0);
  return saturate(vec3<f32>(r, g, b));
}

// Mode 2: Turbulence — grayscale 0->1
fn turbulenceToColor(turb: f32) -> vec3<f32> {
  let t = clamp(turb, 0.0, 1.0);
  return vec3<f32>(t, t, t);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let bary = vec3<f32>(in.barycentric, 1.0 - in.barycentric.x - in.barycentric.y);

  let minBary = min(bary.x, min(bary.y, bary.z));
  let fw = fwidth(minBary);
  let edge = smoothstep(0.0, fw * 1.5, minBary);

  let mode = u32(params.colorMode);

  var fillColor: vec3<f32>;
  switch (mode) {
    case 1u: { fillColor = directionOffsetToColor(in.directionOffset); }
    case 2u: { fillColor = turbulenceToColor(in.turbulence); }
    default: { fillColor = speedFactorToColor(in.speedFactor); }
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
}

interface CursorSample {
  speedFactor: number;
  directionOffset: number;
  turbulence: number;
}

const BARY_INSIDE_EPS = 0.001;
const DEGENERATE_TRIANGLE_EPS = 1e-10;

const COLOR_MODE_NAMES = ["Speed Factor", "Direction Offset", "Turbulence"];

export class WindMeshDebugMode extends DebugRenderMode {
  layer = "windViz" as const;
  private colorMode = 0;
  private selectedSource = 0;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms: UniformInstance<
    typeof WindMeshDebugUniforms.fields
  > | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private initialized = false;

  private cachedWireframe: WireframeBuffer | null = null;
  private cachedSourceData: WindMeshSourceData | null = null;

  @on("add")
  async onAdd() {
    await this.initPipeline();
  }

  private async initPipeline(): Promise<void> {
    if (this.initialized) return;

    const device = this.game.getWebGPUDevice();

    const shaderModule = device.createShaderModule({
      code: SHADER_CODE,
      label: "Wind Mesh Debug Shader",
    });
    await validateShaderModuleCompilation(
      shaderModule,
      SHADER_CODE,
      "Wind Mesh Debug Shader",
    );

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Wind Mesh Debug Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Wind Mesh Debug Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 28, // 7 floats x 4 bytes
            attributes: [
              { format: "float32x2", offset: 0, shaderLocation: 0 }, // position
              { format: "float32", offset: 8, shaderLocation: 1 }, // speedFactor
              { format: "float32", offset: 12, shaderLocation: 2 }, // directionOffset
              { format: "float32", offset: 16, shaderLocation: 3 }, // turbulence
              { format: "float32x2", offset: 20, shaderLocation: 4 }, // barycentric
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
      label: "Wind Mesh Debug Pipeline",
    });

    this.uniformBuffer = device.createBuffer({
      size: WindMeshDebugUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Wind Mesh Debug Uniforms",
    });

    this.uniforms = WindMeshDebugUniforms.create();

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
      label: "Wind Mesh Debug Bind Group",
    });

    this.initialized = true;
  }

  private getActiveSource(): WindMeshSourceData | null {
    const windResources = this.game.entities.tryGetSingleton(WindResources);
    const bundle = windResources?.getWindMeshData();
    if (!bundle || bundle.sourceCount === 0) return null;
    const idx = Math.min(this.selectedSource, bundle.sourceCount - 1);
    return bundle.sources[idx];
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

    const source = this.getActiveSource();
    if (!source) return;

    const device = this.game.getWebGPUDevice();
    const wireframe = this.getWireframeBuffer(source, device);

    const renderer = this.game.getRenderer();
    const renderPass = renderer.getCurrentRenderPass();
    if (!renderPass) return;

    const cameraMatrix = renderer.getTransform();
    const width = renderer.getWidth();
    const height = renderer.getHeight();

    this.uniforms.set.cameraMatrix(cameraMatrix);
    this.uniforms.set.screenWidth(width);
    this.uniforms.set.screenHeight(height);
    this.uniforms.set.alpha(0.3);
    this.uniforms.set.colorMode(this.colorMode);
    this.uniforms.uploadTo(this.uniformBuffer);

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.setVertexBuffer(0, wireframe.buffer);
    renderPass.draw(wireframe.vertexCount);
  }

  private getWireframeBuffer(
    sourceData: WindMeshSourceData,
    device: GPUDevice,
  ): WireframeBuffer {
    if (this.cachedWireframe && this.cachedSourceData === sourceData) {
      return this.cachedWireframe;
    }

    if (this.cachedWireframe) {
      this.cachedWireframe.buffer.destroy();
    }

    const { vertices, indices, indexCount } = sourceData;
    const floatsPerVertex = 7; // posX, posY, speedFactor, directionOffset, turbulence, baryU, baryV
    const expanded = new Float32Array(indexCount * floatsPerVertex);

    for (let i = 0; i < indexCount; i++) {
      const srcBase = indices[i] * WIND_VERTEX_FLOATS;
      const dstBase = i * floatsPerVertex;
      const bary = BARY_COORDS[i % BARY_COORDS.length];

      // Copy 5 source floats (posX, posY, speedFactor, directionOffset, turbulence)
      expanded[dstBase] = vertices[srcBase];
      expanded[dstBase + 1] = vertices[srcBase + 1];
      expanded[dstBase + 2] = vertices[srcBase + 2];
      expanded[dstBase + 3] = vertices[srcBase + 3];
      expanded[dstBase + 4] = vertices[srcBase + 4];
      // Append barycentric coords
      expanded[dstBase + 5] = bary[0];
      expanded[dstBase + 6] = bary[1];
    }

    const buffer = device.createBuffer({
      size: expanded.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: "Wind Mesh Debug Wireframe",
    });
    device.queue.writeBuffer(buffer, 0, expanded);

    this.cachedWireframe = { buffer, vertexCount: indexCount };
    this.cachedSourceData = sourceData;
    return this.cachedWireframe;
  }

  private sampleMeshAtPoint(
    sourceData: WindMeshSourceData,
    px: number,
    py: number,
  ): CursorSample | null {
    const { vertices, indices, indexCount } = sourceData;

    for (let i = 0; i < indexCount; i += 3) {
      const ia = indices[i] * WIND_VERTEX_FLOATS;
      const ib = indices[i + 1] * WIND_VERTEX_FLOATS;
      const ic = indices[i + 2] * WIND_VERTEX_FLOATS;

      const ax = vertices[ia];
      const ay = vertices[ia + 1];
      const bx = vertices[ib];
      const by = vertices[ib + 1];
      const cx = vertices[ic];
      const cy = vertices[ic + 1];

      const bary = this.computeBarycentric(px, py, ax, ay, bx, by, cx, cy);
      if (!bary) continue;

      const [u, v, w] = bary;
      if (u < -BARY_INSIDE_EPS || v < -BARY_INSIDE_EPS || w < -BARY_INSIDE_EPS)
        continue;

      return {
        speedFactor:
          vertices[ia + 2] * u + vertices[ib + 2] * v + vertices[ic + 2] * w,
        directionOffset:
          vertices[ia + 3] * u + vertices[ib + 3] * v + vertices[ic + 3] * w,
        turbulence:
          vertices[ia + 4] * u + vertices[ib + 4] * v + vertices[ic + 4] * w,
      };
    }

    return null;
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

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]): void {
    if (key === "KeyV") {
      this.cycleColorMode(event.shiftKey ? -1 : 1);
    }
    if (key === "KeyB") {
      this.cycleSource(event.shiftKey ? -1 : 1);
    }
  }

  private cycleColorMode(direction: 1 | -1): void {
    const n = COLOR_MODE_NAMES.length;
    this.colorMode = (this.colorMode + direction + n) % n;
  }

  private cycleSource(direction: 1 | -1): void {
    const windResources = this.game.entities.tryGetSingleton(WindResources);
    const bundle = windResources?.getWindMeshData();
    if (!bundle || bundle.sourceCount <= 1) return;
    const n = bundle.sourceCount;
    this.selectedSource = (this.selectedSource + direction + n) % n;
    // Invalidate cached wireframe so it rebuilds for the new source
    this.cachedSourceData = null;
  }

  @on("destroy")
  onDestroy(): void {
    this.uniformBuffer?.destroy();
    if (this.cachedWireframe) {
      this.cachedWireframe.buffer.destroy();
      this.cachedWireframe = null;
    }
  }

  getModeName(): string {
    return "Wind Mesh";
  }

  getHudInfo(): JSX.Element | string | null {
    const windResources = this.game.entities.tryGetSingleton(WindResources);
    const bundle = windResources?.getWindMeshData();
    if (!bundle) return "No wind mesh data";

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

    const sourceIdx = Math.min(this.selectedSource, bundle.sourceCount - 1);
    const source = bundle.sources[sourceIdx];
    const triCount = Math.floor(source.indexCount / 3);
    const dirDeg = ((source.direction * 180) / Math.PI).toFixed(1);
    const weights = windResources?.getSourceWeights() ?? [];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={controlLineStyle}>
          <span style={labelStyle}>Mode</span>
          <span
            style={chipStyle}
            onClick={() => this.cycleColorMode(1)}
            title="Click to cycle (V / Shift+V)"
          >
            {COLOR_MODE_NAMES[this.colorMode]}
          </span>
        </span>
        <span style={controlLineStyle}>
          <span style={labelStyle}>Source</span>
          <span
            style={chipStyle}
            onClick={() => this.cycleSource(1)}
            title="Click to cycle (B / Shift+B)"
          >
            {sourceIdx + 1}/{bundle.sourceCount} ({dirDeg}&deg;, w=
            {(weights[sourceIdx] ?? 0).toFixed(2)})
          </span>
        </span>
        <div style={dimStyle}>
          <span>
            {bundle.gridCols}&times;{bundle.gridRows} grid{" "}
            {(source.vertexCount / 1000).toFixed(1)}k verts {triCount} tris
          </span>
        </div>
      </div>
    );
  }

  getCursorInfo(): JSX.Element | string | null {
    const mouseWorldPos = this.game.camera.toWorld(this.game.io.mousePosition);
    if (!mouseWorldPos) return null;

    const source = this.getActiveSource();

    const rowStyle = {
      display: "flex",
      gap: "8px",
      alignItems: "baseline",
      flexWrap: "wrap" as const,
    };
    const labelStyle = { color: "#8fa3b8", fontSize: "11px" };
    const valueStyle = { color: "#d9e6f2", fontSize: "11px" };

    if (!source) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={labelStyle}>Wind Mesh</span>
          <span style={valueStyle}>No wind mesh data</span>
        </div>
      );
    }

    const sample = this.sampleMeshAtPoint(
      source,
      mouseWorldPos.x,
      mouseWorldPos.y,
    );

    if (!sample) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={labelStyle}>Wind Mesh</span>
          <span style={valueStyle}>No mesh coverage at cursor</span>
        </div>
      );
    }

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span style={rowStyle}>
          <span style={labelStyle}>Wind Mesh</span>
        </span>
        <span style={rowStyle}>
          <span style={labelStyle}>speed</span>
          <span style={valueStyle}>{sample.speedFactor.toFixed(2)}</span>
          <span style={labelStyle}>dir</span>
          <span style={valueStyle}>{sample.directionOffset.toFixed(2)}</span>
          <span style={labelStyle}>turb</span>
          <span style={valueStyle}>{sample.turbulence.toFixed(2)}</span>
        </span>
      </div>
    );
  }
}
