import { on } from "../../../core/entity/handler";
import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

import { BaseQuery } from "../query/BaseQuery";
import { GpuQueryManager } from "../query/GpuQueryManager";
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
/**
 * Snapshot of the parameters the GPU used on its most recent dispatch.
 * Populated at the end of `dispatchCompute`. Consumed by the CPU/GPU
 * parity check.
 */
export interface WindDispatchParams {
  time: number;
  baseWindX: number;
  baseWindY: number;
  influenceSpeedFactor: number;
  influenceDirectionOffset: number;
  influenceTurbulence: number;
  /** Copied so later frames don't mutate the snapshot. */
  weights: Float32Array;
  /** Reference to the packed buffer that was bound — not a copy. */
  packedWindMesh: Uint32Array | null;
}

export class WindQueryManager extends GpuQueryManager {
  id = "windQueryManager";
  tickLayer = "query" as const;

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniforms = WindQueryUniforms.create();

  /**
   * Snapshot of the params used by the most recently *completed* dispatch
   * — i.e., the dispatch that produced the results currently visible to
   * queries. Promoted from `pendingDispatchParams` in `onResultsReady`.
   *
   * Null until at least one dispatch has fully round-tripped.
   */
  lastCompletedDispatchParams: WindDispatchParams | null = null;

  /** Snapshot of the most recent dispatch; not yet reflected in results. */
  private pendingDispatchParams: WindDispatchParams | null = null;

  protected override onResultsReady(): void {
    this.lastCompletedDispatchParams = this.pendingDispatchParams;
    this.pendingDispatchParams = null;
  }

  constructor() {
    super(WindResultLayout, MAX_WIND_QUERIES);
    this.queryShader = createWindQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    super.onAdd();
    await this.queryShader!.init();

    const device = this.game.getWebGPUDevice();
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
    if (pointCount === 0) return;

    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[WindQuery] Shader not initialized");
      return;
    }

    const windResources = this.game.entities.getSingleton(WindResources);
    const baseWind = windResources.getBaseVelocity();
    const sourceWeights = windResources.getSourceWeights();

    const time = performance.now() / 1000;
    const influenceSpeedFactor = 1.0;
    const influenceDirectionOffset = 0.0;
    const influenceTurbulence = 0.0;

    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.time(time);
    this.uniforms.set.baseWindX(baseWind.x);
    this.uniforms.set.baseWindY(baseWind.y);
    this.uniforms.set.influenceSpeedFactor(influenceSpeedFactor);
    this.uniforms.set.influenceDirectionOffset(influenceDirectionOffset);
    this.uniforms.set.influenceTurbulence(influenceTurbulence);
    this.uniforms.set.numActiveWindSources(sourceWeights.length);

    this.uniforms.set.weights0(sourceWeights[0] ?? 0);
    this.uniforms.set.weights1(sourceWeights[1] ?? 0);
    this.uniforms.set.weights2(sourceWeights[2] ?? 0);
    this.uniforms.set.weights3(sourceWeights[3] ?? 0);
    this.uniforms.set.weights4(sourceWeights[4] ?? 0);
    this.uniforms.set.weights5(sourceWeights[5] ?? 0);
    this.uniforms.set.weights6(sourceWeights[6] ?? 0);
    this.uniforms.set.weights7(sourceWeights[7] ?? 0);

    this.uniforms.uploadTo(this.uniformBuffer);

    const weightsCopy = new Float32Array(8);
    for (let i = 0; i < 8; i++) weightsCopy[i] = sourceWeights[i] ?? 0;
    this.pendingDispatchParams = {
      time,
      baseWindX: baseWind.x,
      baseWindY: baseWind.y,
      influenceSpeedFactor,
      influenceDirectionOffset,
      influenceTurbulence,
      weights: weightsCopy,
      packedWindMesh: windResources.getPackedWindMeshRaw(),
    };

    const windMeshBuffer = windResources.getPackedWindMeshBuffer();
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
      packedWindMesh: { buffer: windMeshBuffer },
    });

    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.wind"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
  }
}
