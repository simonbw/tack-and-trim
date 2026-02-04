import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { V, type V2d } from "../../../core/Vector";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager, type ResultLayout } from "../query/QueryManager";
import { createWaterQueryShader } from "./WaterQueryShader";
import { WaterResources } from "./WaterResources";

/**
 * Result data from a water query at a specific point
 */
export interface WaterQueryResult {
  /** Surface height at this point (world Y coordinate) */
  surfaceHeight: number;
  /** Water velocity (m/s) */
  velocity: V2d;
  /** Surface normal vector (points up from water) */
  normal: V2d;
  /** Water depth at this point (meters, undefined if unknown) */
  depth: number | undefined;
}

/**
 * Entity that queries water data at multiple points each frame.
 */
export class WaterQuery extends BaseQuery<WaterQueryResult> {
  // Tag for discovery by WaterQueryManager
  tags = ["waterQuery"];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }
}

/**
 * Named constants for water result buffer layout
 */
const WaterResultLayout: ResultLayout = {
  stride: 6,
  fields: {
    surfaceHeight: 0,
    velocityX: 1,
    velocityY: 2,
    normalX: 3,
    normalY: 4,
    depth: 5,
  },
};

const MAX_WATER_QUERIES = 2 ** 15;

/**
 * Query manager for water queries.
 *
 * Handles GPU-accelerated water sampling for surface height, velocity, normals, and depth.
 * Uses shared buffers from WaterResources singleton.
 */
export class WaterQueryManager extends QueryManager<WaterQueryResult> {
  id = "waterQueryManager";
  tickLayer = "environment";

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor() {
    super(WaterResultLayout, MAX_WATER_QUERIES);
    this.queryShader = createWaterQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    // Call parent onAdd (not async, so we need to handle separately)
    super.onAdd();

    // Initialize shader
    await this.queryShader!.init();

    // Create uniform buffer for query parameters (24 bytes)
    // pointCount (u32=4) + time (f32=4) + tideHeight (f32=4) + waveSourceDirection (f32=4) + modifierCount (u32=4) + _padding (f32=4)
    const device = getWebGPU().device;
    this.uniformBuffer = device.createBuffer({
      label: "Water Query Uniform Buffer",
      size: 24,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  getQueries(): BaseQuery<WaterQueryResult>[] {
    return [...this.game.entities.byConstructor(WaterQuery)];
  }

  packResult(
    result: WaterQueryResult,
    buffer: Float32Array,
    offset: number,
  ): void {
    const { fields } = WaterResultLayout;
    buffer[offset + fields.surfaceHeight] = result.surfaceHeight;
    buffer[offset + fields.velocityX] = result.velocity.x;
    buffer[offset + fields.velocityY] = result.velocity.y;
    buffer[offset + fields.normalX] = result.normal.x;
    buffer[offset + fields.normalY] = result.normal.y;
    buffer[offset + fields.depth] = result.depth ?? 0;
  }

  unpackResult(buffer: Float32Array, offset: number): WaterQueryResult {
    const { fields } = WaterResultLayout;
    return {
      surfaceHeight: buffer[offset + fields.surfaceHeight],
      velocity: V(
        buffer[offset + fields.velocityX],
        buffer[offset + fields.velocityY],
      ),
      normal: V(
        buffer[offset + fields.normalX],
        buffer[offset + fields.normalY],
      ),
      depth: buffer[offset + fields.depth],
    };
  }

  dispatchCompute(pointCount: number): void {
    // Skip if no points to query
    if (pointCount === 0) {
      return;
    }

    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[WaterQuery] Shader not initialized");
      return;
    }

    // Get WaterResources singleton for shared buffers
    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    if (!waterResources) {
      console.warn("[WaterQuery] WaterResources not found");
      return;
    }

    const device = getWebGPU().device;

    // Get data from WaterResources
    const tideHeight = waterResources.getTideHeight();
    const waveSourceDirection =
      waterResources.getAnalyticalConfig().waveSourceDirection;
    const modifierCount = waterResources.getModifierCount();

    // Update uniform buffer (24 bytes)
    // Use ArrayBuffer with typed views for mixed u32/f32 data
    const uniformBuffer = new ArrayBuffer(24);
    const u32View = new Uint32Array(uniformBuffer);
    const f32View = new Float32Array(uniformBuffer);
    u32View[0] = pointCount; // u32 pointCount
    f32View[1] = performance.now() / 1000; // f32 time
    f32View[2] = tideHeight; // f32 tideHeight
    f32View[3] = waveSourceDirection; // f32 waveSourceDirection
    u32View[4] = modifierCount; // u32 modifierCount
    f32View[5] = 0; // f32 _padding
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformBuffer);

    // Create bind group with shared buffers from WaterResources
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      waveData: { buffer: waterResources.waveDataBuffer },
      modifiers: { buffer: waterResources.modifiersBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
    });

    // Dispatch compute shader with GPU profiling
    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const commandEncoder = device.createCommandEncoder({
      label: "Water Query Compute",
    });
    const computePass = commandEncoder.beginComputePass({
      label: "Water Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("waterQuery"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  @on("destroy")
  onDestroy(): void {
    this.uniformBuffer?.destroy();
  }
}
