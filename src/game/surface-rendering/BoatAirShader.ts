/**
 * Boat air rasterization pass.
 *
 * Publishes each boat's "air gap" — the 3D region above the bilge surface
 * and below the deck cap — into a screen-space rgba16float texture
 * (`boatAirTexture`). Read by the water height compute shader, which
 * substitutes the bilge surface for the ocean wherever the ocean would
 * lie inside the air column. One uniform per-pixel range test naturally
 * handles dry boats, wet bilges, partial submersion, and full submersion.
 *
 * Texture layout:
 *   R = airMin     (bilge surface Z, or sentinel low when dry / outside)
 *   G = airMax     (deck cap Z,     or sentinel low outside the hull)
 *   B = turbulence (slosh velocity magnitude, drives bilge foam)
 *   A = unused
 *
 * Two draws per boat, sharing one render pass and one vertex shader:
 *
 *   1. Bilge polygon — only the wetted cross-section. writeMask = R | B.
 *      Fragment outputs (interpolated bilge Z, _, slosh, _).
 *
 *   2. Deck cap mesh — the full hull top-down footprint. writeMask = G.
 *      Fragment outputs (_, interpolated deck Z, _, _).
 *
 * Channel write masks let the two draws layer non-destructively into the
 * same texture: each touches disjoint channels, and unwritten channels
 * keep the clear value (or whatever the other draw wrote earlier).
 *
 * Vertex format is shared: 3 floats per vertex (worldX, worldY, worldZ).
 * The bilge draw interprets worldZ as the bilge surface height; the deck
 * draw interprets it as the deck cap height. The vertex shader is
 * identical in both cases.
 */

import { defineUniformStruct, f32 } from "../../core/graphics/UniformStruct";
import { getWebGPU } from "../../core/graphics/webgpu/WebGPUDevice";
import type { Boat } from "../boat/Boat";
import type { Viewport } from "../wave-physics/WavePhysicsResources";

/** 3 floats per vertex: worldX, worldY, worldZ. */
export const BOAT_AIR_VERTEX_SIZE = 3;
const BOAT_AIR_VERTEX_STRIDE = BOAT_AIR_VERTEX_SIZE * 4; // 12 bytes

// Sentinel value written to airMin (R) and airMax (G) at pixels with no
// air gap. Far below any realistic water height so `airMax > airMin` is
// false at non-hull pixels and the substitution is naturally skipped.
// Fits comfortably in f16 (max magnitude 65504).
export const BOAT_AIR_SENTINEL_LOW = -1e4;

const BoatAirUniforms = defineUniformStruct("BoatAirUniforms", {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  turbulence: f32,
});

const SHADER_SOURCE = /*wgsl*/ `
${BoatAirUniforms.wgsl}

@group(0) @binding(0) var<uniform> uniforms: BoatAirUniforms;

struct VertexInput {
  @location(0) worldPos: vec3<f32>,
}

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldZ: f32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  // Map world XY into the air texture's viewport-space clip coordinates.
  // Must match the mapping the water height compute uses when reading the
  // texture (it samples by uv = pixel/screen, which is also the same
  // mapping the water filter uses for waterHeightTexture).
  //
  // Pixel (0,0) corresponds to world (viewportLeft, viewportTop), and
  // pixel y increases with world y. WebGPU NDC has +Y pointing UP but
  // the framebuffer origin is top-left, so clip y = +1 maps to pixel
  // y = 0 — we flip Y when converting u/v to clip space.
  let u = (in.worldPos.x - uniforms.viewportLeft) / uniforms.viewportWidth;
  let v = (in.worldPos.y - uniforms.viewportTop) / uniforms.viewportHeight;
  var out: VertexOutput;
  out.clipPos = vec4<f32>(u * 2.0 - 1.0, 1.0 - v * 2.0, 0.0, 1.0);
  out.worldZ = in.worldPos.z;
  return out;
}

// Bilge fragment: writes airMin (R) and turbulence (B). G and A are
// masked out by the pipeline writeMask, so the deck cap draw can layer
// independently. Only invoked over the wetted bilge cross-section.
@fragment
fn fs_bilge(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(in.worldZ, 0.0, uniforms.turbulence, 0.0);
}

// Deck cap fragment: writes airMax (G). R, B, and A are masked out.
// Invoked over the entire hull top-down footprint (deckIndices polygon).
@fragment
fn fs_deck(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, in.worldZ, 0.0, 0.0);
}
`;

let bilgePipeline: GPURenderPipeline | null = null;
let deckPipeline: GPURenderPipeline | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (bilgePipeline && deckPipeline) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const gpu = getWebGPU();
    const device = gpu.device;

    const shaderModule = await gpu.createShaderModuleChecked(
      SHADER_SOURCE,
      "Boat Air Shader",
    );

    bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
      label: "Boat Air Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
      label: "Boat Air Pipeline Layout",
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: BOAT_AIR_VERTEX_STRIDE,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, // worldPos
      ],
    };

    // Bilge pipeline: writes only R (airMin) and B (turbulence).
    bilgePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_bilge",
        targets: [
          {
            format: "rgba16float",
            writeMask: GPUColorWrite.RED | GPUColorWrite.BLUE,
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      label: "Boat Air Bilge Pipeline",
    });

    // Deck cap pipeline: writes only G (airMax).
    deckPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [vertexBufferLayout],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_deck",
        targets: [
          {
            format: "rgba16float",
            writeMask: GPUColorWrite.GREEN,
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      label: "Boat Air Deck Cap Pipeline",
    });
  })();

  return initPromise;
}

const CLEAR_COLOR: GPUColor = {
  r: BOAT_AIR_SENTINEL_LOW,
  g: BOAT_AIR_SENTINEL_LOW,
  b: 0,
  a: 0,
};

export class BoatAirShader {
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniforms = BoatAirUniforms.create();

  // Scratch vertex/index buffers, grown on demand. Shared across boats
  // since we draw them sequentially within one render pass.
  private deckVertexBuffer: GPUBuffer | null = null;
  private deckIndexBuffer: GPUBuffer | null = null;
  private deckVertexCapacity = 0;
  private deckIndexCapacity = 0;
  private deckScratchVerts = new Float32Array(0);

  private bilgeVertexBuffer: GPUBuffer | null = null;
  private bilgeIndexBuffer: GPUBuffer | null = null;
  private bilgeVertexCapacity = 0;
  private bilgeIndexCapacity = 0;
  private bilgeScratchVerts = new Float32Array(0);
  private bilgeScratchIndices = new Uint16Array(0);

  constructor() {
    ensureInitialized();
  }

  /**
   * Rasterize a single boat's air gap into `boatAirTexture`. Runs as a
   * standalone command encoder + render pass with `loadOp: "clear"` so
   * each frame starts from sentinel everywhere.
   */
  render(targetView: GPUTextureView, viewport: Viewport, boat: Boat): void {
    if (!bilgePipeline || !deckPipeline || !bindGroupLayout) {
      // Pipelines still initializing — fall back to a clear so the
      // texture isn't garbage. Air substitution will be a no-op this
      // frame.
      this.clear(targetView);
      return;
    }

    const device = getWebGPU().device;
    this.ensureUniformBuffer(device);

    // Bake deck cap vertices in world space.
    const heightMesh = boat.hull.getHeightMeshData();
    const deckVertexCount = this.bakeDeckCapVerts(boat, heightMesh);
    const deckIndexCount = heightMesh.deckIndices.length;

    // Bake bilge surface polygon (optional — only when wet).
    let bilgeVertexCount = 0;
    let bilgeIndexCount = 0;
    let bilgeTurbulence = 0;
    if (boat.bilge.getWaterFraction() > 0) {
      const built = this.bakeBilgeSurface(boat);
      bilgeVertexCount = built.vertexCount;
      bilgeIndexCount = built.indexCount;
      bilgeTurbulence = this.computeBilgeTurbulence(boat);
    }

    // Upload uniforms.
    this.uniforms.set.viewportLeft(viewport.left);
    this.uniforms.set.viewportTop(viewport.top);
    this.uniforms.set.viewportWidth(viewport.width);
    this.uniforms.set.viewportHeight(viewport.height);
    this.uniforms.set.turbulence(bilgeTurbulence);
    this.uniforms.uploadTo(this.uniformBuffer!);

    // Upload deck cap GPU buffers.
    this.uploadDeckBuffers(device, deckVertexCount, heightMesh.deckIndices);

    // Upload bilge GPU buffers if we have a surface.
    if (bilgeVertexCount > 0) {
      this.uploadBilgeBuffers(device, bilgeVertexCount, bilgeIndexCount);
    }

    const commandEncoder = device.createCommandEncoder({
      label: "Boat Air Command Encoder",
    });
    const pass = commandEncoder.beginRenderPass({
      label: "Boat Air Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: CLEAR_COLOR,
        },
      ],
    });

    pass.setBindGroup(0, this.bindGroup!);

    // Draw 1: bilge surface (writes airMin R + turbulence B).
    if (bilgeVertexCount >= 3 && bilgeIndexCount >= 3) {
      pass.setPipeline(bilgePipeline);
      pass.setVertexBuffer(0, this.bilgeVertexBuffer!);
      pass.setIndexBuffer(this.bilgeIndexBuffer!, "uint16");
      pass.drawIndexed(bilgeIndexCount);
    }

    // Draw 2: deck cap (writes airMax G).
    if (deckVertexCount >= 3 && deckIndexCount >= 3) {
      pass.setPipeline(deckPipeline);
      pass.setVertexBuffer(0, this.deckVertexBuffer!);
      pass.setIndexBuffer(this.deckIndexBuffer!, "uint16");
      pass.drawIndexed(deckIndexCount);
    }

    pass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Clear the air texture to the no-air sentinel. Called when there are
   * no boats (editor mode, between levels) so the water height compute's
   * substitution is a uniform no-op.
   */
  clear(targetView: GPUTextureView): void {
    const device = getWebGPU().device;
    const commandEncoder = device.createCommandEncoder({
      label: "Boat Air Clear",
    });
    const pass = commandEncoder.beginRenderPass({
      label: "Boat Air Clear Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: CLEAR_COLOR,
        },
      ],
    });
    pass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  private ensureUniformBuffer(device: GPUDevice): void {
    if (this.uniformBuffer) return;
    this.uniformBuffer = device.createBuffer({
      size: BoatAirUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Boat Air Uniform Buffer",
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout!,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      label: "Boat Air Bind Group",
    });
  }

  /**
   * Bake the hull's deck cap vertices (xyPositions + zValues) into
   * world-space (worldX, worldY, worldZ) triples by transforming each
   * vertex through the boat's 6DOF body orientation. Re-uses
   * `deckIndices` unchanged.
   */
  private bakeDeckCapVerts(
    boat: Boat,
    mesh: { xyPositions: [number, number][]; zValues: number[] },
  ): number {
    const xy = mesh.xyPositions;
    const z = mesh.zValues;
    const vertexCount = xy.length;
    const needed = vertexCount * BOAT_AIR_VERTEX_SIZE;
    if (this.deckScratchVerts.length < needed) {
      this.deckScratchVerts = new Float32Array(needed);
    }

    const body = boat.hull.body;
    const R = body.orientation;
    const bx = body.position[0];
    const by = body.position[1];
    const bz = body.z;

    const out = this.deckScratchVerts;
    for (let i = 0; i < vertexCount; i++) {
      const lx = xy[i][0];
      const ly = xy[i][1];
      const lz = z[i];
      const wx = R[0] * lx + R[1] * ly + R[2] * lz + bx;
      const wy = R[3] * lx + R[4] * ly + R[5] * lz + by;
      const wz = R[6] * lx + R[7] * ly + R[8] * lz + bz;
      const off = i * BOAT_AIR_VERTEX_SIZE;
      out[off] = wx;
      out[off + 1] = wy;
      out[off + 2] = wz;
    }
    return vertexCount;
  }

  private bakeBilgeSurface(boat: Boat): {
    vertexCount: number;
    indexCount: number;
  } {
    const maxVerts = boat.bilge.maxHullWaterVertices;
    const neededVerts = maxVerts * BOAT_AIR_VERTEX_SIZE;
    if (this.bilgeScratchVerts.length < neededVerts) {
      this.bilgeScratchVerts = new Float32Array(neededVerts);
    }
    const maxTris = Math.max(0, maxVerts - 2);
    const neededIndices = maxTris * 3;
    // Pad to even length so the byte length is a 4-byte multiple (uint16).
    const paddedIndices = neededIndices + (neededIndices & 1);
    if (this.bilgeScratchIndices.length < paddedIndices) {
      this.bilgeScratchIndices = new Uint16Array(paddedIndices);
    }
    return boat.bilge.buildHullWaterVertices(
      this.bilgeScratchVerts,
      this.bilgeScratchIndices,
    );
  }

  private computeBilgeTurbulence(boat: Boat): number {
    // Slosh velocity magnitude — drives the water filter's foam pathway
    // through the B channel of boatAirTexture (and via the substitution,
    // into the G channel of waterHeightTexture).
    const sx = boat.bilge.getSlopeXVelocity();
    const sy = boat.bilge.getSlopeYVelocity();
    return Math.hypot(sx, sy);
  }

  private uploadDeckBuffers(
    device: GPUDevice,
    vertexCount: number,
    indices: number[],
  ): void {
    if (vertexCount > this.deckVertexCapacity) {
      this.deckVertexBuffer?.destroy();
      this.deckVertexCapacity = vertexCount;
      this.deckVertexBuffer = device.createBuffer({
        size: vertexCount * BOAT_AIR_VERTEX_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: "Boat Air Deck Vertex Buffer",
      });
    }
    const vBytes = vertexCount * BOAT_AIR_VERTEX_STRIDE;
    device.queue.writeBuffer(
      this.deckVertexBuffer!,
      0,
      this.deckScratchVerts.buffer,
      this.deckScratchVerts.byteOffset,
      vBytes,
    );

    const paddedCount = indices.length + (indices.length & 1);
    if (paddedCount > this.deckIndexCapacity) {
      this.deckIndexBuffer?.destroy();
      this.deckIndexCapacity = paddedCount;
      this.deckIndexBuffer = device.createBuffer({
        size: paddedCount * 2,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: "Boat Air Deck Index Buffer",
      });
    }
    const indexData = new Uint16Array(paddedCount);
    for (let i = 0; i < indices.length; i++) indexData[i] = indices[i];
    device.queue.writeBuffer(
      this.deckIndexBuffer!,
      0,
      indexData.buffer,
      indexData.byteOffset,
      indexData.byteLength,
    );
  }

  private uploadBilgeBuffers(
    device: GPUDevice,
    vertexCount: number,
    indexCount: number,
  ): void {
    if (vertexCount > this.bilgeVertexCapacity) {
      this.bilgeVertexBuffer?.destroy();
      this.bilgeVertexCapacity = vertexCount;
      this.bilgeVertexBuffer = device.createBuffer({
        size: vertexCount * BOAT_AIR_VERTEX_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: "Boat Air Bilge Vertex Buffer",
      });
    }
    const vBytes = vertexCount * BOAT_AIR_VERTEX_STRIDE;
    device.queue.writeBuffer(
      this.bilgeVertexBuffer!,
      0,
      this.bilgeScratchVerts.buffer,
      this.bilgeScratchVerts.byteOffset,
      vBytes,
    );

    const paddedCount = indexCount + (indexCount & 1);
    if (paddedCount > this.bilgeIndexCapacity) {
      this.bilgeIndexBuffer?.destroy();
      this.bilgeIndexCapacity = paddedCount;
      this.bilgeIndexBuffer = device.createBuffer({
        size: paddedCount * 2,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: "Boat Air Bilge Index Buffer",
      });
    }
    device.queue.writeBuffer(
      this.bilgeIndexBuffer!,
      0,
      this.bilgeScratchIndices.buffer,
      this.bilgeScratchIndices.byteOffset,
      paddedCount * 2,
    );
  }

  destroy(): void {
    this.deckVertexBuffer?.destroy();
    this.deckIndexBuffer?.destroy();
    this.bilgeVertexBuffer?.destroy();
    this.bilgeIndexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.deckVertexBuffer = null;
    this.deckIndexBuffer = null;
    this.bilgeVertexBuffer = null;
    this.bilgeIndexBuffer = null;
    this.uniformBuffer = null;
    this.bindGroup = null;
  }
}
