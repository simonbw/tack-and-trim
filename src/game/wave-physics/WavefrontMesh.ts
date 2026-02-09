/**
 * Wavefront Mesh data class.
 *
 * Holds GPU buffers and CPU data for a marched wavefront mesh.
 * Each mesh represents the propagation of a single wave source through
 * the terrain, with vertices tracking position, amplitude, direction,
 * and phase as the wavefront advances.
 *
 * Vertex layout (5 floats, 20 bytes per vertex):
 * [0] positionX (f32)
 * [1] positionY (f32)
 * [2] amplitudeFactor (f32): 0=blocked, 1=open ocean
 * [3] directionOffset (f32): radians from base direction
 * [4] phaseOffset (f32): accumulated phase correction
 */

/** Number of floats per mesh vertex */
export const VERTEX_FLOATS = 5;

export class WavefrontMesh {
  /** GPU vertex buffer (STORAGE | VERTEX | COPY_SRC), 5 floats per vertex */
  vertexBuffer: GPUBuffer;
  /** GPU index buffer for triangle mesh */
  indexBuffer: GPUBuffer;

  /** CPU copy of vertex data for debug visualization */
  cpuVertexData: Float32Array;

  /** Number of marching steps (rows of vertices) */
  numSteps: number;
  /** Number of vertices per wavefront row */
  vertexCount: number;

  /** Mesh origin X in world space */
  meshOriginX: number;
  /** Mesh origin Y in world space */
  meshOriginY: number;
  /** Base wave direction X component */
  waveDirX: number;
  /** Base wave direction Y component */
  waveDirY: number;
  /** Perpendicular direction X component */
  perpDirX: number;
  /** Perpendicular direction Y component */
  perpDirY: number;
  /** Average step distance between wavefronts */
  avgStepDistance: number;
  /** Spacing between vertices along a wavefront */
  vertexSpacing: number;
  /** Wavelength of the wave source */
  wavelength: number;

  constructor(params: {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    cpuVertexData: Float32Array;
    numSteps: number;
    vertexCount: number;
    meshOriginX: number;
    meshOriginY: number;
    waveDirX: number;
    waveDirY: number;
    perpDirX: number;
    perpDirY: number;
    avgStepDistance: number;
    vertexSpacing: number;
    wavelength: number;
  }) {
    this.vertexBuffer = params.vertexBuffer;
    this.indexBuffer = params.indexBuffer;
    this.cpuVertexData = params.cpuVertexData;
    this.numSteps = params.numSteps;
    this.vertexCount = params.vertexCount;
    this.meshOriginX = params.meshOriginX;
    this.meshOriginY = params.meshOriginY;
    this.waveDirX = params.waveDirX;
    this.waveDirY = params.waveDirY;
    this.perpDirX = params.perpDirX;
    this.perpDirY = params.perpDirY;
    this.avgStepDistance = params.avgStepDistance;
    this.vertexSpacing = params.vertexSpacing;
    this.wavelength = params.wavelength;
  }

  /** Destroy GPU buffers */
  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
  }
}
