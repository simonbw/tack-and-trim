import { on } from "../../../core/entity/handler";
import type { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

import { createPlaceholderPackedMeshBuffer } from "../../wave-physics/MeshPacking";
import { WavePhysicsResources } from "../../wave-physics/WavePhysicsResources";
import { createPlaceholderTideMeshBuffer } from "./TideMeshPacking";
import { TidalResources } from "./TidalResources";
import { BaseQuery } from "../query/BaseQuery";
import { QueryManager } from "../query/QueryManager";
import { DEFAULT_DEPTH } from "../terrain/TerrainConstants";
import { TerrainResources } from "../terrain/TerrainResources";
import { WaterQuery } from "./WaterQuery";
import { WaterResultLayout } from "./WaterQueryResult";
import { createWaterQueryShader, WaterQueryUniforms } from "./WaterQueryShader";
import { WaterResources } from "./WaterResources";

const MAX_WATER_QUERIES = 2 ** 15;

/**
 * Query manager for water queries.
 *
 * Handles GPU-accelerated water sampling for surface height, velocity, normals, and depth.
 * Uses shared buffers from WaterResources singleton.
 */
export class WaterQueryManager extends QueryManager {
  id = "waterQueryManager";
  tickLayer = "query" as const;

  private queryShader: ComputeShader | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private placeholderPackedMeshBuffer: GPUBuffer | null = null;
  private placeholderTideMeshBuffer: GPUBuffer | null = null;
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
    this.placeholderTideMeshBuffer = device.createBuffer({
      label: "Placeholder Tide Mesh Buffer",
      size: createPlaceholderTideMeshBuffer().byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.placeholderTideMeshBuffer,
      0,
      createPlaceholderTideMeshBuffer(),
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

    const tidalResources =
      this.game.entities.tryGetSingleton(TidalResources);
    const packedTideMeshBuffer =
      tidalResources?.getPackedBuffer(this.game.getWebGPUDevice()) ??
      this.placeholderTideMeshBuffer!;

    this.uniforms.set.pointCount(pointCount);
    this.uniforms.set.time(performance.now() / 1000);
    this.uniforms.set.tideHeight(tideHeight);
    this.uniforms.set.modifierCount(modifierCount);
    this.uniforms.set.contourCount(terrainResources.getContourCount());
    this.uniforms.set.defaultDepth(DEFAULT_DEPTH);
    this.uniforms.set.numWaves(waterResources.getNumWaves());
    this.uniforms.set.tidalPhase(tidalResources?.getTidalPhase() ?? 0);
    this.uniforms.set.tidalStrength(tidalResources?.getTidalStrength() ?? 0);
    this.uniforms.set._padding2(0);
    this.uniforms.set._padding3(0);
    this.uniforms.set._padding4(0);
    this.uniforms.uploadTo(this.uniformBuffer);

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
