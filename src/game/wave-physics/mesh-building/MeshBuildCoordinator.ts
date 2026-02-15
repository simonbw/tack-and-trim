/**
 * Mesh Build Coordinator (main thread)
 *
 * Manages web worker lifecycle for mesh building:
 * - Delegates worker lifecycle and scheduling to WorkerPool
 * - Serializes terrain data for worker transfer
 * - Submits one request per mesh build and collects results
 * - Creates GPU resources from CPU mesh data
 */

import { WorkerPool } from "../../../core/workers/WorkerPool";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WaveSource } from "../../world/water/WaveSource";
import { WavefrontMesh } from "../WavefrontMesh";
import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";
import type {
  MeshBuildBounds,
  MeshBuilderType,
  MeshBuildRequest,
  MeshBuildResult,
} from "./MeshBuildTypes";

/** Maximum number of concurrent workers */
const MAX_WORKERS = 4;

/** Worker initialization timeout in ms */
const INIT_TIMEOUT = 5000;

/**
 * Coordinates mesh building across web workers.
 */
export class MeshBuildCoordinator {
  private pool: WorkerPool<MeshBuildRequest, MeshBuildResult>;
  private nextRequestId = 0;

  constructor() {
    const cores = navigator.hardwareConcurrency || 4;
    const workerCount = Math.min(Math.max(cores - 1, 1), MAX_WORKERS);

    this.pool = new WorkerPool<MeshBuildRequest, MeshBuildResult>({
      workerUrl: new URL("./MeshBuildWorker.ts", import.meta.url),
      label: "MeshBuildWorker",
      workerCount,
      initTimeoutMs: INIT_TIMEOUT,
      defaultRequestTimeoutMs: 30000,
    });
  }

  /**
   * Initialize workers and wait for ready signals.
   */
  async initialize(): Promise<void> {
    if (this.pool.isReady()) return;
    await this.pool.initialize();
  }

  /**
   * Build meshes for all wave sources using the specified builder types.
   *
   * @returns Map from builder type to array of meshes (one per wave source)
   */
  async buildMeshes(
    waveSources: WaveSource[],
    terrainGPUData: TerrainCPUData,
    coastlineBounds: MeshBuildBounds | null,
    tideHeight: number,
    builderTypes: MeshBuilderType[],
  ): Promise<Map<MeshBuilderType, WavefrontMesh[]>> {
    if (!this.pool.isReady()) {
      await this.initialize();
    }

    const device = getWebGPU().device;

    // Build all requests: one per (waveSource, builderType) pair
    interface PendingBuild {
      order: number;
      waveSourceIndex: number;
      waveSource: WaveSource;
      builderType: MeshBuilderType;
      request: MeshBuildRequest;
    }

    const pendingBuilds: PendingBuild[] = [];
    for (const builderType of builderTypes) {
      for (let i = 0; i < waveSources.length; i++) {
        pendingBuilds.push({
          order: pendingBuilds.length,
          waveSourceIndex: i,
          waveSource: waveSources[i],
          builderType,
          request: this.createRequest(
            this.nextRequestId++,
            builderType,
            waveSources[i],
            terrainGPUData,
            coastlineBounds,
            tideHeight,
          ),
        });
      }
    }

    const results = await this.executeBuildBatch(pendingBuilds);

    // Organize results by builder type and create GPU resources
    const meshSets = new Map<MeshBuilderType, WavefrontMesh[]>();
    for (const builderType of builderTypes) {
      meshSets.set(builderType, []);
    }

    for (const { pending, result } of results) {
      const mesh = WavefrontMesh.fromMeshData(
        result.meshData,
        pending.waveSource,
        pending.builderType,
        result.buildTimeMs,
        device,
      );

      meshSets.get(pending.builderType)!.push(mesh);
    }

    return meshSets;
  }

  /**
   * Execute a batch of builds across available workers.
   */
  private async executeBuildBatch(
    pendingBuilds: {
      order: number;
      waveSourceIndex: number;
      waveSource: WaveSource;
      builderType: MeshBuilderType;
      request: MeshBuildRequest;
    }[],
  ): Promise<{ pending: (typeof pendingBuilds)[0]; result: MeshBuildResult }[]> {
    const results: {
      pending: (typeof pendingBuilds)[0];
      result: MeshBuildResult;
    }[] = [];

    await Promise.all(
      pendingBuilds.map(async (pending) => {
        const label = `${pending.builderType} wave ${pending.waveSourceIndex}`;
        const startTime = performance.now();

        try {
          const result = await this.pool.submitRequest(pending.request, {
            transferables: [
              pending.request.terrain.vertexData.buffer,
              pending.request.terrain.contourData,
              pending.request.terrain.childrenData.buffer,
            ],
            timeoutMs: 30000,
          });
          results.push({ pending, result });
        } catch (err) {
          const elapsed = performance.now() - startTime;
          console.error(
            `[MeshBuildCoordinator] FAILED ${label} after ${elapsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}ms:`,
            err,
          );
        }
      }),
    );

    results.sort((a, b) => a.pending.order - b.pending.order);
    return results;
  }

  private createRequest(
    requestId: number,
    builderType: MeshBuilderType,
    waveSource: WaveSource,
    terrainGPUData: TerrainCPUData,
    bounds: MeshBuildBounds | null,
    tideHeight: number,
  ): MeshBuildRequest {
    // Clone typed arrays since they'll be transferred
    const terrainForWorker: TerrainCPUData = {
      vertexData: new Float32Array(terrainGPUData.vertexData),
      contourData: terrainGPUData.contourData.slice(0),
      childrenData: new Uint32Array(terrainGPUData.childrenData),
      contourCount: terrainGPUData.contourCount,
      defaultDepth: terrainGPUData.defaultDepth,
    };

    return {
      type: "build",
      requestId,
      builderType,
      waveSource,
      terrain: terrainForWorker,
      coastlineBounds: bounds,
      tideHeight,
    };
  }

  /**
   * Terminate all workers.
   */
  terminate(): void {
    this.pool.terminate();
  }
}
