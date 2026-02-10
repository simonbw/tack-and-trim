/**
 * Wavefront Mesh data class.
 *
 * Holds GPU buffers and CPU data for a wavefront mesh built by any builder type.
 * Each mesh represents the propagation of a single wave source through
 * the terrain, with vertices tracking position, amplitude, direction,
 * and phase as the wavefront advances.
 *
 * Vertex layout (6 floats, 24 bytes per vertex):
 * [0] positionX (f32)
 * [1] positionY (f32)
 * [2] amplitudeFactor (f32): 0=blocked, 1=open ocean
 * [3] directionOffset (f32): radians from base direction
 * [4] phaseOffset (f32): accumulated phase correction
 * [5] blendWeight (f32): 0=use open ocean defaults, 1=use mesh values
 */

import type { WavefrontMeshData } from "./mesh-building/MeshBuildTypes";
import type { MeshBuilderType } from "./mesh-building/MeshBuildTypes";
import type { WaveSource } from "../world/water/WaveSource";

/** Number of floats per mesh vertex */
export const VERTEX_FLOATS = 6;

export class WavefrontMesh {
  /** GPU vertex buffer (STORAGE | VERTEX | COPY_SRC), 6 floats per vertex */
  vertexBuffer: GPUBuffer;
  /** GPU index buffer for triangle mesh */
  indexBuffer: GPUBuffer;

  /** CPU copy of vertex data for debug visualization */
  cpuVertexData: Float32Array;

  /** CPU copy of index data for spatial grid building */
  cpuIndexData: Uint32Array;

  /** Total number of vertices in the mesh */
  vertexCount: number;
  /** Total number of indices in the mesh */
  indexCount: number;

  /** Wavelength of the wave source */
  wavelength: number;
  /** Wave direction in radians */
  waveDirection: number;

  /** Which builder produced this mesh */
  builderType: MeshBuilderType;

  /** Time taken to build this mesh in milliseconds */
  buildTimeMs: number;

  constructor(params: {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    cpuVertexData: Float32Array;
    cpuIndexData: Uint32Array;
    vertexCount: number;
    indexCount: number;
    wavelength: number;
    waveDirection: number;
    builderType: MeshBuilderType;
    buildTimeMs: number;
  }) {
    this.vertexBuffer = params.vertexBuffer;
    this.indexBuffer = params.indexBuffer;
    this.cpuVertexData = params.cpuVertexData;
    this.cpuIndexData = params.cpuIndexData;
    this.vertexCount = params.vertexCount;
    this.indexCount = params.indexCount;
    this.wavelength = params.wavelength;
    this.waveDirection = params.waveDirection;
    this.builderType = params.builderType;
    this.buildTimeMs = params.buildTimeMs;
  }

  /**
   * Create a WavefrontMesh from CPU mesh data by uploading to GPU buffers.
   * Workers produce WavefrontMeshData, main thread calls this to create GPU resources.
   */
  static fromMeshData(
    data: WavefrontMeshData,
    waveSource: WaveSource,
    builderType: MeshBuilderType,
    buildTimeMs: number,
    device: GPUDevice,
  ): WavefrontMesh {
    // Create GPU vertex buffer
    const vertexBuffer = device.createBuffer({
      size: data.vertices.byteLength,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.VERTEX |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
      label: `Wavefront Mesh Vertices (${builderType})`,
    });
    device.queue.writeBuffer(vertexBuffer, 0, data.vertices.buffer);

    // Create GPU index buffer
    const indexBuffer = device.createBuffer({
      size: data.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: `Wavefront Mesh Index Buffer (${builderType})`,
    });
    device.queue.writeBuffer(indexBuffer, 0, data.indices.buffer);

    return new WavefrontMesh({
      vertexBuffer,
      indexBuffer,
      cpuVertexData: data.vertices,
      cpuIndexData: data.indices,
      vertexCount: data.vertexCount,
      indexCount: data.indexCount,
      wavelength: waveSource.wavelength,
      waveDirection: waveSource.direction,
      builderType,
      buildTimeMs,
    });
  }

  /** Destroy GPU buffers */
  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
  }
}
