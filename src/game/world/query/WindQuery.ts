import { V, type V2d } from "../../../core/Vector";
import type Entity from "../../../core/entity/Entity";
import { BaseQuery } from "./BaseQuery";
import { QueryManager, type ResultLayout } from "./QueryManager";
import { WindQueryShader } from "../wind/WindQueryShader";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";

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
 * Type guard for WindQuery entities
 */
export function isWindQuery(entity: Entity): entity is WindQuery {
  return entity instanceof WindQuery;
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

  private queryShader: WindQueryShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor() {
    super(WindResultLayout, MAX_WIND_QUERIES);
    this.queryShader = new WindQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    super.onAdd();
    await this.queryShader!.init();

    const device = getWebGPU().device;
    this.uniformBuffer = device.createBuffer({
      label: "Wind Query Uniform Buffer",
      size: 8, // pointCount (u32) + time (f32) = 8 bytes
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
    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[WindQuery] Shader not initialized");
      return;
    }

    const device = getWebGPU().device;

    // Update uniform buffer
    const uniformData = new Float32Array(2);
    uniformData[0] = pointCount;
    uniformData[1] = performance.now() / 1000;
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Create bind group
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
    });

    // Dispatch compute shader
    const commandEncoder = device.createCommandEncoder({
      label: "Wind Query Compute",
    });
    const computePass = commandEncoder.beginComputePass({
      label: "Wind Query Compute Pass",
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }
}
