import { on } from "../../../core/entity/handler";
import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager } from "../query/QueryManager";
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
export class TerrainQueryManager extends QueryManager {
  id = "terrainQueryManager";
  tickLayer = "query" as const;

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = TerrainQueryUniforms.create();

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

    // Skip dispatch if no points to query
    if (pointCount === 0) {
      return;
    }

    // Get terrain resources
    const terrainResources = this.game.entities.getSingleton(TerrainResources);

    // Update uniform buffer with query parameters
    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.contourCount(terrainResources.getContourCount());
    this.uniforms.set.defaultDepth(DEFAULT_DEPTH);
    this.uniforms.set._padding(0);
    this.uniforms.uploadTo(this.uniformBuffer);

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
    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.terrain"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
  }
}
