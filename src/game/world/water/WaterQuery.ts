import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { V, type V2d } from "../../../core/Vector";
import { on } from "../../../core/entity/handler";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager, type ResultLayout } from "../query/QueryManager";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { createWaterQueryShader, WaterQueryUniforms } from "./WaterQueryShader";
import { WaterResources } from "./WaterResources";
import { TerrainResources } from "../terrain/TerrainResources";
import { DEFAULT_DEPTH } from "../terrain/TerrainConstants";

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
  private placeholderShadowDataBuffer: GPUBuffer | null = null;
  private placeholderShadowVerticesBuffer: GPUBuffer | null = null;
  private uniforms = WaterQueryUniforms.create();

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

    // Create uniform buffer for query parameters
    const device = getWebGPU().device;
    this.uniformBuffer = device.createBuffer({
      label: "Water Query Uniform Buffer",
      size: WaterQueryUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create placeholder shadow data buffer (empty - no polygons)
    // Layout: 32 bytes header with polygonCount = 0
    this.placeholderShadowDataBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Query Placeholder Shadow Data Buffer",
    });
    const placeholderData = new Float32Array([
      1.0,
      0.0, // waveDirection
      0, // polygonCount (will be overwritten)
      0,
      0,
      0,
      0, // viewport
      0, // padding
    ]);
    const placeholderUint = new Uint32Array(placeholderData.buffer);
    placeholderUint[2] = 0; // Set polygonCount to 0
    device.queue.writeBuffer(
      this.placeholderShadowDataBuffer,
      0,
      placeholderData,
    );

    // Create placeholder shadow vertices buffer (empty - just needs to exist)
    this.placeholderShadowVerticesBuffer = device.createBuffer({
      size: 8, // Minimum size: one vec2<f32>
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Water Query Placeholder Shadow Vertices Buffer",
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

    // Get WavePhysicsResources for shadow data
    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const shadowDataBuffer =
      wavePhysicsResources?.getShadowDataBuffer() ??
      this.placeholderShadowDataBuffer!;
    const shadowVerticesBuffer =
      wavePhysicsResources?.getShadowVerticesBuffer() ??
      this.placeholderShadowVerticesBuffer!;

    // Get TerrainResources for analytical terrain height computation
    const terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources);
    if (!terrainResources) {
      console.warn("[WaterQuery] TerrainResources not found");
      return;
    }

    const device = getWebGPU().device;

    // Get data from WaterResources
    const tideHeight = waterResources.getTideHeight();
    const waveSourceDirection =
      waterResources.getAnalyticalConfig().waveSourceDirection;
    const modifierCount = waterResources.getModifierCount();

    // Update uniform buffer
    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.time(performance.now() / 1000);
    this.uniforms.set.tideHeight(tideHeight);
    this.uniforms.set.waveSourceDirection(waveSourceDirection);
    this.uniforms.set.modifierCount(modifierCount);
    this.uniforms.set.contourCount(terrainResources.getContourCount());
    this.uniforms.set.defaultDepth(DEFAULT_DEPTH);
    this.uniforms.set.numWaves(waterResources.getNumWaves());
    this.uniforms.set.swellWaveCount(waterResources.getSwellWaveCount());
    this.uniforms.set._padding0(0);
    this.uniforms.set._padding1(0);
    this.uniforms.set._padding2(0);
    this.uniforms.uploadTo(this.uniformBuffer);

    // Create bind group with shared buffers (including terrain for depth computation)
    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      waveData: { buffer: waterResources.waveDataBuffer },
      modifiers: { buffer: waterResources.modifiersBuffer },
      shadowData: { buffer: shadowDataBuffer },
      shadowVertices: { buffer: shadowVerticesBuffer },
      vertices: { buffer: terrainResources.vertexBuffer },
      contours: { buffer: terrainResources.contourBuffer },
      children: { buffer: terrainResources.childrenBuffer },
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
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.water"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  @on("destroy")
  onDestroy(): void {
    this.uniformBuffer?.destroy();
    this.placeholderShadowDataBuffer?.destroy();
    this.placeholderShadowVerticesBuffer?.destroy();
  }
}
