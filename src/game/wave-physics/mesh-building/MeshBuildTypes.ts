/**
 * Shared types for the mesh building system.
 *
 * These types flow between the main thread and web workers:
 * - Main thread serializes terrain + wave data into worker requests
 * - Workers produce WavefrontMeshData (CPU-only, no GPU resources)
 * - Main thread creates GPU buffers from the mesh data
 */

import type { WaveSource } from "../../world/water/WaveSource";
import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";

/** Builder type identifier */
export type MeshBuilderType = "marching";

/**
 * CPU-only mesh data — what workers produce and transfer back.
 * Contains raw vertex/index arrays ready for GPU upload.
 */
export interface WavefrontMeshData {
  /** 6 floats per vertex: [x, y, amplitude, dirOffset, phaseOffset, blendWeight] */
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

/** What a worker receives */
export interface MeshBuildRequest {
  type: "build";
  requestId: number;
  builderType: MeshBuilderType;
  waveSource: WaveSource;
  terrain: TerrainCPUData;
  coastlineBounds: MeshBuildBounds | null;
  tideHeight: number;
}

/** What a worker returns on success */
export interface MeshBuildResult {
  type: "result";
  requestId: number;
  builderType: MeshBuilderType;
  meshData: WavefrontMeshData;
  buildTimeMs: number;
}

/** Worker ready signal */
export interface MeshBuildReady {
  type: "ready";
}

/** Worker error signal */
export interface MeshBuildError {
  type: "error";
  requestId: number;
  message: string;
}

/** Messages from worker to main thread */
export type WorkerOutMessage =
  | MeshBuildReady
  | MeshBuildResult
  | MeshBuildError;

/** Messages from main thread to worker */
export type WorkerInMessage = MeshBuildRequest;
