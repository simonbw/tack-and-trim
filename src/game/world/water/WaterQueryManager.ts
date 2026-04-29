import { on } from "../../../core/entity/handler";
import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

import {
  createPlaceholderPackedMeshBuffer,
  createPlaceholderPackedMeshData,
} from "../../wave-physics/MeshPacking";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { createPlaceholderTideMeshBuffer } from "./TideMeshPacking";
import { TidalResources } from "./TidalResources";
import { BaseQuery } from "../query/BaseQuery";
import { GpuQueryManager } from "../query/GpuQueryManager";
import { DEFAULT_DEPTH } from "../terrain/TerrainConstants";
import { TerrainResources } from "../terrain/TerrainResources";
import { WaterQuery } from "./WaterQuery";
import { WaterResultLayout } from "./WaterQueryResult";
import { createWaterQueryShader, WaterQueryUniforms } from "./WaterQueryShader";
import { FLOATS_PER_MODIFIER, WaterResources } from "./WaterResources";
import { WeatherState } from "../../weather/WeatherState";

const MAX_WATER_QUERIES = 2 ** 15;

/**
 * Query manager for water queries.
 *
 * Handles GPU-accelerated water sampling for surface height, velocity, normals, and depth.
 * Uses shared buffers from WaterResources singleton.
 */
/**
 * Snapshot of the parameters the GPU used on its most recent dispatch.
 * Populated at the end of `dispatchCompute`. Consumed by the CPU/GPU
 * parity check, which replays the same math on the CPU and diffs.
 *
 * The `modifiers` field is a *copy* taken at dispatch time, because
 * `WaterResources.modifierData` is mutated live each tick — a mere
 * reference would drift between GPU dispatch and CPU replay.
 */
export interface WaterDispatchParams {
  time: number;
  tideHeight: number;
  defaultDepth: number;
  numWaves: number;
  tidalPhase: number;
  tidalStrength: number;
  waveAmplitudeScale: number;
  contourCount: number;
  modifierCount: number;
  /** Snapshot of the first `modifierCount` modifiers. */
  modifiers: Float32Array;
  /** Snapshot — waveSourceData is level-immutable but copied for safety. */
  waveSources: Float32Array;
  /** Reference to the packed buffer that was bound — not a copy. */
  packedTerrain: Uint32Array;
  packedWaveMesh: Uint32Array;
  packedTideMesh: Uint32Array;
}

export class WaterQueryManager extends GpuQueryManager {
  id = "waterQueryManager";
  tickLayer = "query" as const;

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private placeholderPackedMeshBuffer: GPUBuffer | null = null;
  private placeholderTideMeshBuffer: GPUBuffer | null = null;
  private uniforms = WaterQueryUniforms.create();

  /**
   * Snapshot of the params used by the most recently *completed* dispatch
   * — i.e., the dispatch that produced the results currently visible to
   * queries. Promoted from `pendingDispatchParams` in `onResultsReady`.
   *
   * Null until at least one dispatch has fully round-tripped.
   */
  lastCompletedDispatchParams: WaterDispatchParams | null = null;

  /** Snapshot of the most recent dispatch; not yet reflected in results. */
  private pendingDispatchParams: WaterDispatchParams | null = null;

  protected override onResultsReady(): void {
    this.lastCompletedDispatchParams = this.pendingDispatchParams;
    this.pendingDispatchParams = null;
  }

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
    const device = this.game.getWebGPUDevice();
    this.uniformBuffer = device.createBuffer({
      label: "Water Query Uniform Buffer",
      size: WaterQueryUniforms.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create placeholder packed mesh buffer (empty - no wave sources)
    this.placeholderPackedMeshBuffer = createPlaceholderPackedMeshBuffer(
      this.game.getWebGPUDevice(),
    );

    // Create placeholder tide mesh buffer (empty - no tidal data)
    const placeholderTideMesh = createPlaceholderTideMeshBuffer();
    this.placeholderTideMeshBuffer = device.createBuffer({
      label: "Placeholder Tide Mesh Buffer",
      size: placeholderTideMesh.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.placeholderTideMeshBuffer,
      0,
      placeholderTideMesh.buffer,
      placeholderTideMesh.byteOffset,
      placeholderTideMesh.byteLength,
    );
  }

  getQueries(): BaseQuery<unknown>[] {
    return [...this.game.entities.byConstructor(WaterQuery)];
  }

  dispatchCompute(pointCount: number, commandEncoder: GPUCommandEncoder): void {
    if (pointCount === 0) return;

    if (!this.queryShader || !this.uniformBuffer) {
      console.warn("[WaterQuery] Shader not initialized");
      return;
    }

    const waterResources = this.game.entities.tryGetSingleton(WaterResources);
    if (!waterResources) {
      console.warn("[WaterQuery] WaterResources not found");
      return;
    }

    const wavePhysicsResources =
      this.game.entities.tryGetSingleton(WavePhysicsResources);
    const packedMeshBuffer =
      wavePhysicsResources?.getPackedMeshBuffer() ??
      this.placeholderPackedMeshBuffer!;

    const terrainResources =
      this.game.entities.tryGetSingleton(TerrainResources);
    if (!terrainResources) {
      console.warn("[WaterQuery] TerrainResources not found");
      return;
    }

    const tideHeight = waterResources.getTideHeight();
    const modifierCount = waterResources.getModifierCount();

    const tidalResources = this.game.entities.tryGetSingleton(TidalResources);
    const packedTideMeshBuffer =
      tidalResources?.getPackedBuffer(this.game.getWebGPUDevice()) ??
      this.placeholderTideMeshBuffer!;

    const time = performance.now() / 1000;
    const contourCount = terrainResources.getContourCount();
    const numWaves = waterResources.getNumWaves();
    const tidalPhase = tidalResources?.getTidalPhase() ?? 0;
    const tidalStrength = tidalResources?.getTidalStrength() ?? 0;

    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.time(time);
    this.uniforms.set.tideHeight(tideHeight);
    this.uniforms.set.modifierCount(modifierCount);
    this.uniforms.set.contourCount(contourCount);
    this.uniforms.set.defaultDepth(DEFAULT_DEPTH);
    this.uniforms.set.numWaves(numWaves);
    this.uniforms.set.tidalPhase(tidalPhase);
    this.uniforms.set.tidalStrength(tidalStrength);
    const weather = this.game.entities.tryGetSingleton(WeatherState);
    this.uniforms.set.waveAmplitudeScale(weather?.waveAmplitudeScale ?? 1.0);
    this.uniforms.set._padding3(0);
    this.uniforms.set._padding4(0);
    this.uniforms.uploadTo(this.uniformBuffer);

    // Snapshot dispatch params for parity testing. Modifiers mutate live,
    // so we copy the active slice. Packed buffers are immutable here so a
    // reference is fine.
    const modifierFloats = modifierCount * FLOATS_PER_MODIFIER;
    const modifiersCopy = new Float32Array(modifierFloats);
    if (modifierFloats > 0) {
      modifiersCopy.set(
        new Float32Array(
          waterResources.getModifierDataSab(),
          0,
          modifierFloats,
        ),
      );
    }
    const waveSourceData = waterResources.getWaveSourceData();
    const waveSourcesCopy = new Float32Array(waveSourceData.length);
    waveSourcesCopy.set(waveSourceData);
    this.pendingDispatchParams = {
      time,
      tideHeight,
      defaultDepth: DEFAULT_DEPTH,
      numWaves,
      tidalPhase,
      tidalStrength,
      waveAmplitudeScale: weather?.waveAmplitudeScale ?? 1.0,
      contourCount,
      modifierCount,
      modifiers: modifiersCopy,
      waveSources: waveSourcesCopy,
      packedTerrain: terrainResources.getPackedTerrainRaw(),
      packedWaveMesh:
        wavePhysicsResources?.getPackedMeshRaw() ??
        createPlaceholderPackedMeshData(),
      packedTideMesh:
        tidalResources?.getPackedTideMeshRaw() ??
        createPlaceholderTideMeshBuffer(),
    };

    const bindGroup = this.queryShader.createBindGroup({
      params: { buffer: this.uniformBuffer },
      waveData: { buffer: waterResources.waveDataBuffer },
      modifiers: { buffer: waterResources.modifiersBuffer },
      packedMesh: { buffer: packedMeshBuffer },
      packedTerrain: { buffer: terrainResources.packedTerrainBuffer },
      packedTideMesh: { buffer: packedTideMeshBuffer },
      pointBuffer: { buffer: this.pointBuffer },
      resultBuffer: { buffer: this.resultBuffer },
    });

    const gpuProfiler = this.game.getRenderer().getGpuProfiler();
    const computePass = commandEncoder.beginComputePass({
      label: "Water Query Compute Pass",
      timestampWrites: gpuProfiler?.getComputeTimestampWrites("query.water"),
    });
    this.queryShader.dispatch(computePass, bindGroup, pointCount, 1);
    computePass.end();
  }

  @on("destroy")
  onDestroy(): void {
    this.uniformBuffer?.destroy();
    this.placeholderPackedMeshBuffer?.destroy();
    this.placeholderTideMeshBuffer?.destroy();
  }
}
