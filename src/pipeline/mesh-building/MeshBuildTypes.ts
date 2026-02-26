/**
 * Shared types for the mesh building system.
 *
 * These types describe wavefront mesh data produced by the offline
 * build-wavemesh tool and loaded at runtime from .wavemesh binary files.
 */

/** Builder type identifier */
export type MeshBuilderType = "marching";

/**
 * CPU-only mesh data — raw vertex/index arrays ready for GPU upload.
 */
export interface WavefrontMeshData {
  /** 6 floats per vertex: [x, y, amplitude, turbulence, phaseOffset, blendWeight] */
  vertices: Float32Array;
  /** Triangle indices */
  indices: Uint32Array;
  /** Number of active vertices */
  vertexCount: number;
  /** Number of active indices */
  indexCount: number;
  /** World-space oriented quad corners for shadow/open-ocean distinction (4 corners, CW or CCW) */
  coverageQuad: CoverageQuad | null;
}

/** Axis-aligned bounding box for mesh build domain */
export interface MeshBuildBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 4 corners of an oriented bounding quad in world space (for rasterizer coverage) */
export interface CoverageQuad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}
