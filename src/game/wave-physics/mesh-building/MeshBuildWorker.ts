/**
 * Web Worker entry point for mesh building.
 *
 * On load, posts { type: 'ready' }.
 * On message, dispatches to the appropriate builder function and returns the result
 * with transferable buffers for zero-copy transfer.
 */

import { buildMarchingMesh } from "./marchingBuilder";
import { buildMarchingPostTriMesh } from "./marchingPostTriBuilder";
import type {
  MeshBuildRequest,
  WavefrontMeshData,
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
    let meshData: WavefrontMeshData;
    if (request.builderType === "marching") {
      meshData = buildMarchingMesh(
        request.waveSource,
        request.coastlineBounds,
        request.terrain,
        request.tideHeight,
      );
    } else if (request.builderType === "marching_posttri") {
      meshData = buildMarchingPostTriMesh(
        request.waveSource,
        request.coastlineBounds,
        request.terrain,
        request.tideHeight,
      );
    } else {
      throw new Error(`Unknown mesh builder type: ${request.builderType}`);
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
