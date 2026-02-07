import { on } from "../../../core/entity/handler";
import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager } from "../query/QueryManager";
import { WindQuery } from "./WindQuery";
import { WindResultLayout } from "./WindQueryResult";
import { createWindQueryShader, WindQueryUniforms } from "./WindQueryShader";
import { WindResources } from "./WindResources";

const MAX_WIND_QUERIES = 2 ** 15;

/**
 * Query manager for wind queries.
 *
 * Handles GPU-accelerated wind sampling for velocity, speed, and direction.
 */
export class WindQueryManager extends QueryManager {
  id = "windQueryManager";
  tickLayer = "query" as const;

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = WindQueryUniforms.create();

  constructor() {
    super(WindResultLayout, MAX_WIND_QUERIES);
    this.queryShader = createWindQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    super.onAdd();
    await this.queryShader!.init();

    const device = getWebGPU().device;
    this.uniformBuffer = device.createBuffer({
      label: "Wind Query Uniform Buffer",
      size: WindQueryUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  getQueries(): BaseQuery<unknown>[] {
    return [...this.game.entities.byConstructor(WindQuery)];
  }

  dispatchCompute(pointCount: number, commandEncoder: GPUCommandEncoder): void {
    // Skip if no points to query
    if (pointCount === 0) {
      return;
    }

    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[WindQuery] Shader not initialized");
      return;
    }

    // Get wind parameters from WindResources
    const windResources = this.game.entities.getSingleton(WindResources);
    const baseWind = windResources.getBaseVelocity();

    // Update uniform buffer with wind parameters
    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.time(performance.now() / 1000);
    this.uniforms.set.baseWindX(baseWind.x);
    this.uniforms.set.baseWindY(baseWind.y);
    this.uniforms.set.influenceSpeedFactor(1.0);
    this.uniforms.set.influenceDirectionOffset(0.0);
    this.uniforms.set.influenceTurbulence(0.0);
    this.uniforms.set._padding(0.0);
    this.uniforms.uploadTo(this.uniformBuffer);

    // Create bind group
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
    });

    // Dispatch compute shader with GPU profiling
    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.wind"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
  }
}
