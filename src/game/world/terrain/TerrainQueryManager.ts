import { on } from "../../../core/entity/handler";
import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

import { BaseQuery } from "../query/BaseQuery";
import { GpuQueryManager } from "../query/GpuQueryManager";
import { DEFAULT_DEPTH } from "./TerrainConstants";
import { TerrainQuery } from "./TerrainQuery";
import { TerrainResultLayout } from "./TerrainQueryResult";
import {
  createTerrainQueryShader,
  TerrainQueryUniforms,
} from "./TerrainQueryShader";
import { TerrainResources } from "./TerrainResources";

const MAX_TERRAIN_QUERIES = 2 ** 15;

/**
 * Query manager for terrain queries.
 *
 * Handles GPU-accelerated terrain sampling for height, normals, and terrain type.
 */
/**
 * Snapshot of the parameters the GPU used on its most recent dispatch.
 * Populated at the end of `dispatchCompute`. Consumed by the CPU/GPU
 * parity check, which replays the same math on the CPU and diffs.
 */
export interface TerrainDispatchParams {
  contourCount: number;
  defaultDepth: number;
  /** Reference to the packed buffer that was bound — not a copy. */
  packedTerrain: Uint32Array;
}

export class TerrainQueryManager extends GpuQueryManager {
  id = "terrainQueryManager";
  tickLayer = "query" as const;

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = TerrainQueryUniforms.create();

  /**
   * Snapshot of the params used by the most recently *completed* dispatch
   * — i.e., the dispatch that produced the results currently visible to
   * queries. Promoted from `pendingDispatchParams` in `onResultsReady`.
   *
   * Null until at least one dispatch has fully round-tripped.
   */
  lastCompletedDispatchParams: TerrainDispatchParams | null = null;

  /** Snapshot of the most recent dispatch; not yet reflected in results. */
  private pendingDispatchParams: TerrainDispatchParams | null = null;

  protected override onResultsReady(): void {
    this.lastCompletedDispatchParams = this.pendingDispatchParams;
    this.pendingDispatchParams = null;
  }

  constructor() {
    super(TerrainResultLayout, MAX_TERRAIN_QUERIES);
    this.queryShader = createTerrainQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    super.onAdd();
    await this.queryShader!.init();

    const device = this.game.getWebGPUDevice();
    this.uniformBuffer = device.createBuffer({
      label: "Terrain Query Uniform Buffer",
      size: TerrainQueryUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  getQueries(): BaseQuery<unknown>[] {
    return [...this.game.entities.byConstructor(TerrainQuery)];
  }

  dispatchCompute(pointCount: number, commandEncoder: GPUCommandEncoder): void {
    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[TerrainQuery] Shader not initialized");
      return;
    }

    if (pointCount === 0) return;

    const terrainResources = this.game.entities.getSingleton(TerrainResources);

    const contourCount = terrainResources.getContourCount();
    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.contourCount(contourCount);
    this.uniforms.set.defaultDepth(DEFAULT_DEPTH);
    this.uniforms.set._padding(0);
    this.uniforms.uploadTo(this.uniformBuffer);

    this.pendingDispatchParams = {
      contourCount,
      defaultDepth: DEFAULT_DEPTH,
      packedTerrain: terrainResources.getPackedTerrainRaw(),
    };

    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
      packedTerrain: { buffer: terrainResources.packedTerrainBuffer },
    });

    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.terrain"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
  }
}
