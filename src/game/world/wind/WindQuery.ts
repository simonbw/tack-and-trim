import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { V, type V2d } from "../../../core/Vector";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager, type ResultLayout } from "../query/QueryManager";
import { WindResources } from "./WindResources";
import { createWindQueryShader } from "./WindQueryShader";

/**
 * Result data from a wind query at a specific point
 */
export interface WindQueryResult {
  /** Wind velocity vector (m/s) */
  velocity: V2d;
  /** Wind speed (m/s, derived from velocity) */
  speed: number;
  /** Wind direction in radians (derived from velocity) */
  direction: number;
}

/**
 * Entity that queries wind data at multiple points each frame.
 */
export class WindQuery extends BaseQuery<WindQueryResult> {
  // Tag for discovery by WindQueryManager
  tags = ["windQuery"];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }
}

/**
 * Named constants for wind result buffer layout
 */
const WindResultLayout: ResultLayout = {
  stride: 4,
  fields: {
    velocityX: 0,
    velocityY: 1,
    speed: 2,
    direction: 3,
  },
};

const MAX_WIND_QUERIES = 2 ** 15;

/**
 * Query manager for wind queries.
 *
 * Handles GPU-accelerated wind sampling for velocity, speed, and direction.
 */
export class WindQueryManager extends QueryManager<WindQueryResult> {
  id = "windQueryManager";
  tickLayer = "environment";

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;

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
      size: 32, // 8 floats = 32 bytes (pointCount, time, baseWind, influence factors)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  getQueries(): BaseQuery<WindQueryResult>[] {
    return [...this.game.entities.byConstructor(WindQuery)];
  }

  packResult(
    result: WindQueryResult,
    buffer: Float32Array,
    offset: number,
  ): void {
    const { fields } = WindResultLayout;
    buffer[offset + fields.velocityX] = result.velocity.x;
    buffer[offset + fields.velocityY] = result.velocity.y;
    buffer[offset + fields.speed] = result.speed;
    buffer[offset + fields.direction] = result.direction;
  }

  unpackResult(buffer: Float32Array, offset: number): WindQueryResult {
    const { fields } = WindResultLayout;
    return {
      velocity: V(
        buffer[offset + fields.velocityX],
        buffer[offset + fields.velocityY],
      ),
      speed: buffer[offset + fields.speed],
      direction: buffer[offset + fields.direction],
    };
  }

  dispatchCompute(pointCount: number): void {
    // Skip if no points to query
    if (pointCount === 0) {
      return;
    }

    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[WindQuery] Shader not initialized");
      return;
    }

    const device = getWebGPU().device;

    // Get wind parameters from WindResources
    const windResources = this.game.entities.getSingleton(WindResources);
    const baseWind = windResources.getBaseVelocity();

    // Update uniform buffer with wind parameters
    // Use ArrayBuffer with typed views for mixed u32/f32 data
    const uniformBuffer = new ArrayBuffer(32);
    const u32View = new Uint32Array(uniformBuffer);
    const f32View = new Float32Array(uniformBuffer);
    u32View[0] = pointCount; // u32 pointCount
    f32View[1] = performance.now() / 1000; // f32 time
    f32View[2] = baseWind.x; // f32 baseWindX
    f32View[3] = baseWind.y; // f32 baseWindY
    f32View[4] = 1.0; // f32 influenceSpeedFactor (no terrain influence)
    f32View[5] = 0.0; // f32 influenceDirectionOffset (no terrain influence)
    f32View[6] = 0.0; // f32 influenceTurbulence (no terrain influence)
    f32View[7] = 0.0; // f32 _padding
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformBuffer);

    // Create bind group
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
    });

    // Dispatch compute shader with GPU profiling
    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Query Compute",
    });
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.wind"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }
}
