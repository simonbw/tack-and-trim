import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { V, type V2d } from "../../../core/Vector";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { DEFAULT_DEPTH } from "./TerrainConstants";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager, type ResultLayout } from "../query/QueryManager";
import { createTerrainQueryShader } from "./TerrainQueryShader";
import { TerrainResources } from "./TerrainResources";

/**
 * Terrain type enum (placeholder until real TerrainType is available)
 */
export enum TerrainType {
  Water = 0,
  Sand = 1,
  Grass = 2,
  Rock = 3,
}

/**
 * Result data from a terrain query at a specific point
 */
export interface TerrainQueryResult {
  /** Terrain height at this point (world Y coordinate) */
  height: number;
  /** Surface normal vector (points up from terrain) */
  normal: V2d;
  /** Terrain type identifier */
  terrainType: TerrainType;
}

/**
 * Entity that queries terrain data at multiple points each frame.
 */
export class TerrainQuery extends BaseQuery<TerrainQueryResult> {
  // Tag for discovery by TerrainQueryManager
  tags = ["terrainQuery"];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(getPoints: () => ReadonlyArray<V2d>) {
    super(getPoints);
  }
}

/**
 * Named constants for terrain result buffer layout
 */
const TerrainResultLayout: ResultLayout = {
  stride: 4,
  fields: {
    height: 0,
    normalX: 1,
    normalY: 2,
    terrainType: 3,
  },
};

const MAX_TERRAIN_QUERIES = 2 ** 16;
/**
 * Query manager for terrain queries.
 *
 * Handles GPU-accelerated terrain sampling for height, normals, and terrain type.
 */
export class TerrainQueryManager extends QueryManager<TerrainQueryResult> {
  id = "terrainQueryManager";
  tickLayer = "environment";

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor() {
    super(TerrainResultLayout, MAX_TERRAIN_QUERIES);
    this.queryShader = createTerrainQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    super.onAdd();
    await this.queryShader!.init();

    const device = getWebGPU().device;
    this.uniformBuffer = device.createBuffer({
      label: "Terrain Query Uniform Buffer",
      size: 16, // pointCount (u32) + contourCount (u32) + defaultDepth (f32) + padding (f32) = 16 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  getQueries(): BaseQuery<TerrainQueryResult>[] {
    return [...this.game.entities.byConstructor(TerrainQuery)];
  }

  packResult(
    result: TerrainQueryResult,
    buffer: Float32Array,
    offset: number,
  ): void {
    const { fields } = TerrainResultLayout;
    buffer[offset + fields.height] = result.height;
    buffer[offset + fields.normalX] = result.normal.x;
    buffer[offset + fields.normalY] = result.normal.y;
    buffer[offset + fields.terrainType] = result.terrainType;
  }

  unpackResult(buffer: Float32Array, offset: number): TerrainQueryResult {
    const { fields } = TerrainResultLayout;
    return {
      height: buffer[offset + fields.height],
      normal: V(
        buffer[offset + fields.normalX],
        buffer[offset + fields.normalY],
      ),
      terrainType: buffer[offset + fields.terrainType] as TerrainType,
    };
  }

  dispatchCompute(pointCount: number): void {
    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[TerrainQuery] Shader not initialized");
      return;
    }

    // Skip dispatch if no points to query
    if (pointCount === 0) {
      return;
    }

    const device = getWebGPU().device;

    // Get terrain resources
    const terrainResources = this.game.entities.getSingleton(TerrainResources);

    // Update uniform buffer with query parameters
    // Use ArrayBuffer with typed views for mixed u32/f32 data
    const uniformBuffer = new ArrayBuffer(16);
    const u32View = new Uint32Array(uniformBuffer);
    const f32View = new Float32Array(uniformBuffer);
    u32View[0] = pointCount; // u32 pointCount
    u32View[1] = terrainResources.getContourCount(); // u32 contourCount
    f32View[2] = DEFAULT_DEPTH; // f32 defaultDepth
    f32View[3] = 0; // f32 padding
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformBuffer);

    // Create bind group with terrain buffers
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
      vertices: { buffer: terrainResources.vertexBuffer },
      contours: { buffer: terrainResources.contourBuffer },
      children: { buffer: terrainResources.childrenBuffer },
    });

    // Dispatch compute shader with GPU profiling
    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Query Compute",
    });
    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.terrain"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }
}
