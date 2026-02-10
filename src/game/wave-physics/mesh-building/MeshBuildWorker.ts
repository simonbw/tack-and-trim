/**
 * Web Worker entry point for mesh building.
 *
 * On load, posts { type: 'ready' }.
 * On message, dispatches to the appropriate builder function and returns the result
 * with transferable buffers for zero-copy transfer.
 */

import { buildCpuLagrangianMesh } from "./builders/cpuLagrangianBuilder";
import { buildGridEulerianMesh } from "./builders/gridEulerianBuilder";

import { buildTerrainEulerianMesh } from "./builders/terrainEulerianBuilder";
import type {
  MeshBuildRequest,
  MeshBuildResult,
  MeshBuildError,
  WorkerOutMessage,
} from "./MeshBuildTypes";

// Worker-scoped postMessage with transferable support
const workerSelf = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

// Signal ready
workerSelf.postMessage({ type: "ready" } satisfies WorkerOutMessage);

workerSelf.onmessage = (event: MessageEvent<MeshBuildRequest>) => {
  const request = event.data;
  if (request.type !== "build") return;

  const startTime = performance.now();

  try {
    let meshData;

    switch (request.builderType) {
      case "grid-eulerian":
        meshData = buildGridEulerianMesh(
          request.waveSource,
          request.coastlineBounds,
          request.terrain,
          request.tideHeight,
        );
        break;

      case "terrain-eulerian":
        meshData = buildTerrainEulerianMesh(
          request.waveSource,
          request.coastlineBounds,
          request.terrain,
          request.tideHeight,
        );
        break;

      case "cpu-lagrangian":
        meshData = buildCpuLagrangianMesh(
          request.waveSource,
          request.coastlineBounds,
          request.terrain,
          request.tideHeight,
        );
        break;

      default:
        throw new Error(`Unknown builder type: ${request.builderType}`);
    }

    const buildTimeMs = performance.now() - startTime;

    const result: MeshBuildResult = {
      type: "result",
      requestId: request.requestId,
      builderType: request.builderType,
      meshData,
      buildTimeMs,
    };

    // Transfer vertex and index buffers for zero-copy
    workerSelf.postMessage(result, [
      result.meshData.vertices.buffer,
      result.meshData.indices.buffer,
    ]);
  } catch (err) {
    const error: MeshBuildError = {
      type: "error",
      requestId: request.requestId,
      message: err instanceof Error ? err.message : String(err),
    };
    workerSelf.postMessage(error);
  }
};
