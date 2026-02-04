import { V, type V2d } from "../../../core/Vector";
import type Entity from "../../../core/entity/Entity";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager, type ResultLayout } from "../query/QueryManager";
import { WaterQueryShader } from "./WaterQueryShader";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { WaterInfo } from "../../world-data/water/WaterInfo";
import {
  buildWaveDataArray,
  WAVE_COMPONENTS,
} from "../../world-data/water/WaterConstants";

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
 * Type guard for WaterQuery entities
 */
export function isWaterQuery(entity: Entity): entity is WaterQuery {
  return entity instanceof WaterQuery;
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
 */
export class WaterQueryManager extends QueryManager<WaterQueryResult> {
  id = "waterQueryManager";
  tickLayer = "environment";

  private queryShader: WaterQueryShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private waveDataBuffer: GPUBuffer | null = null;

  constructor() {
    super(WaterResultLayout, MAX_WATER_QUERIES);
    this.queryShader = new WaterQueryShader();
  }

  @on("add")
  async onAdd(): Promise<void> {
    // Call parent onAdd (not async, so we need to handle separately)
    super.onAdd();

    // Initialize shader
    await this.queryShader!.init();

    // Create uniform buffer for query parameters
    const device = getWebGPU().device;
    // pointCount (u32=4) + time (f32=4) + tideHeight (f32=4) + waveSourceDirection (f32=4) = 16 bytes
    this.uniformBuffer = device.createBuffer({
      label: "Water Query Uniform Buffer",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create wave data buffer
    const waveData = buildWaveDataArray();
    this.waveDataBuffer = device.createBuffer({
      label: "Water Query Wave Data Buffer",
      size: waveData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.waveDataBuffer.getMappedRange()).set(waveData);
    this.waveDataBuffer.unmap();
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
    if (!this.queryShader || !this.uniformBuffer || !this.waveDataBuffer) {
      console.warn("[WaterQuery] Shader not initialized");
      return;
    }

    const device = getWebGPU().device;

    // Get water info for tide and wave direction
    const waterInfo = this.game.entities.getSingleton(WaterInfo);
    const tideHeight = waterInfo.getTideHeight();
    const waveSourceDirection = WAVE_COMPONENTS[0][2]; // First wave's direction

    // Update uniform buffer
    // Use ArrayBuffer with typed views for mixed u32/f32 data
    const uniformBuffer = new ArrayBuffer(16);
    const u32View = new Uint32Array(uniformBuffer);
    const f32View = new Float32Array(uniformBuffer);
    u32View[0] = pointCount; // u32 pointCount
    f32View[1] = performance.now() / 1000; // f32 time
    f32View[2] = tideHeight; // f32 tideHeight
    f32View[3] = waveSourceDirection; // f32 waveSourceDirection
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformBuffer);

    // Create bind group with wave data
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      waveData: { buffer: this.waveDataBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
    });

    // Dispatch compute shader
    const commandEncoder = device.createCommandEncoder({
      label: "Water Query Compute",
    });
    const computePass = commandEncoder.beginComputePass({
      label: "Water Query Compute Pass",
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  @on("destroy")
  onDestroy(): void {
    this.waveDataBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
