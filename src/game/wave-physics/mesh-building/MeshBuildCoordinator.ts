/**
 * Mesh Build Coordinator (main thread)
 *
 * Manages web worker lifecycle for mesh building:
 * - Spawns workers and waits for ready signals
 * - Serializes terrain data for worker transfer
 * - Submits build requests and collects results
 * - Creates GPU resources from CPU mesh data
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WaveSource } from "../../world/water/WaveSource";
import { WavefrontMesh } from "../WavefrontMesh";
import type {
  MeshBuildBounds,
  MeshBuilderType,
  MeshBuildRequest,
  MeshBuildResult,
  TerrainDataForWorker,
  WorkerOutMessage,
} from "./MeshBuildTypes";

/** Return type of buildTerrainGPUData() */
export interface TerrainGPUData {
  vertexData: Float32Array;
  contourData: ArrayBuffer;
  childrenData: Uint32Array;
  contourCount: number;
  defaultDepth: number;
}

/** Maximum number of concurrent workers */
const MAX_WORKERS = 4;

/** Worker initialization timeout in ms */
const INIT_TIMEOUT = 5000;

/**
 * Coordinates mesh building across web workers.
 */
export class MeshBuildCoordinator {
  private workers: Worker[] = [];
  private ready = false;
  private nextRequestId = 0;

  /**
   * Initialize workers and wait for ready signals.
   */
  async initialize(): Promise<void> {
    if (this.ready) return;

    const cores = navigator.hardwareConcurrency || 4;
    const workerCount = Math.min(Math.max(cores - 1, 1), MAX_WORKERS);

    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(
        new URL("./MeshBuildWorker.ts", import.meta.url),
        { type: "module" },
      );

      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(`MeshBuildWorker ${i} timed out during initialization`),
          );
        }, INIT_TIMEOUT);

        const handler = (event: MessageEvent<WorkerOutMessage>) => {
          if (event.data?.type === "ready") {
            clearTimeout(timeout);
            worker.removeEventListener("message", handler);
            resolve();
          }
        };

        worker.addEventListener("message", handler);
        worker.addEventListener("error", (e) => {
          clearTimeout(timeout);
          reject(new Error(`MeshBuildWorker ${i} error: ${e.message}`));
        });
      });

      this.workers.push(worker);
      readyPromises.push(readyPromise);
    }

    await Promise.all(readyPromises);
    this.ready = true;
  }

  /**
   * Build meshes for all wave sources using the specified builder types.
   *
   * @returns Map from builder type to array of meshes (one per wave source)
   */
  async buildMeshes(
    waveSources: WaveSource[],
    terrainGPUData: TerrainGPUData,
    coastlineBounds: MeshBuildBounds | null,
    tideHeight: number,
    builderTypes: MeshBuilderType[],
  ): Promise<Map<MeshBuilderType, WavefrontMesh[]>> {
    if (!this.ready || this.workers.length === 0) {
      await this.initialize();
    }

    const device = getWebGPU().device;

    // Build all requests: one per (waveSource, builderType) pair
    interface PendingBuild {
      waveSourceIndex: number;
      waveSource: WaveSource;
      builderType: MeshBuilderType;
      requestId: number;
    }

    const pendingBuilds: PendingBuild[] = [];
    for (const builderType of builderTypes) {
      for (let i = 0; i < waveSources.length; i++) {
        pendingBuilds.push({
          waveSourceIndex: i,
          waveSource: waveSources[i],
          builderType,
          requestId: this.nextRequestId++,
        });
      }
    }

    // Execute builds, distributing across available workers
    const results = await this.executeBuildBatch(
      pendingBuilds,
      terrainGPUData,
      coastlineBounds,
      tideHeight,
    );

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
      waveSourceIndex: number;
      waveSource: WaveSource;
      builderType: MeshBuilderType;
      requestId: number;
    }[],
    terrainGPUData: TerrainGPUData,
    bounds: MeshBuildBounds | null,
    tideHeight: number,
  ): Promise<
    {
      pending: (typeof pendingBuilds)[0];
      result: MeshBuildResult;
    }[]
  > {
    const results: {
      pending: (typeof pendingBuilds)[0];
      result: MeshBuildResult;
    }[] = [];

    // Process builds sequentially so a crash in one doesn't affect others
    for (const pending of pendingBuilds) {
      const worker = this.workers[0];
      const label = `${pending.builderType} wave ${pending.waveSourceIndex}`;
      const startTime = performance.now();

      try {
        const result = await this.submitBuild(
          worker,
          pending,
          terrainGPUData,
          bounds,
          tideHeight,
        );
        const elapsed = performance.now() - startTime;
        results.push({ pending, result });
      } catch (err) {
        const elapsed = performance.now() - startTime;
        console.error(
          `[MeshBuildCoordinator] FAILED ${label} after ${elapsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}ms:`,
          err,
        );
      }
    }

    return results;
  }

  /**
   * Submit a single build to a worker and wait for the result.
   */
  private submitBuild(
    worker: Worker,
    pending: {
      waveSource: WaveSource;
      builderType: MeshBuilderType;
      requestId: number;
    },
    terrainGPUData: TerrainGPUData,
    bounds: MeshBuildBounds | null,
    tideHeight: number,
  ): Promise<MeshBuildResult> {
    return new Promise((resolve, reject) => {
      // Clone typed arrays since they'll be transferred
      const terrainForWorker: TerrainDataForWorker = {
        vertexData: new Float32Array(terrainGPUData.vertexData),
        contourData: terrainGPUData.contourData.slice(0),
        childrenData: new Uint32Array(terrainGPUData.childrenData),
        contourCount: terrainGPUData.contourCount,
        defaultDepth: terrainGPUData.defaultDepth,
      };

      const request: MeshBuildRequest = {
        type: "build",
        requestId: pending.requestId,
        builderType: pending.builderType,
        waveSource: pending.waveSource,
        terrain: terrainForWorker,
        coastlineBounds: bounds,
        tideHeight,
      };

      // Timeout to catch worker crashes that don't send error messages
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Worker timed out building ${pending.builderType}`));
      }, 30000);

      const handler = (event: MessageEvent<WorkerOutMessage>) => {
        const msg = event.data;
        if (msg.type === "result" && msg.requestId === pending.requestId) {
          cleanup();
          resolve(msg);
        } else if (
          msg.type === "error" &&
          msg.requestId === pending.requestId
        ) {
          cleanup();
          reject(new Error(msg.message));
        }
      };

      const errorHandler = (e: ErrorEvent) => {
        cleanup();
        reject(new Error(`Worker crashed: ${e.message}`));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener("message", handler);
        worker.removeEventListener("error", errorHandler);
      };

      worker.addEventListener("message", handler);
      worker.addEventListener("error", errorHandler);

      // Transfer terrain data to avoid copying
      const transferables: Transferable[] = [
        terrainForWorker.vertexData.buffer,
        terrainForWorker.contourData,
        terrainForWorker.childrenData.buffer,
      ];

      worker.postMessage(request, transferables);
    });
  }

  /**
   * Terminate all workers.
   */
  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.ready = false;
  }
}
