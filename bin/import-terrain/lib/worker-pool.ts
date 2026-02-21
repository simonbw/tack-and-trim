import { Worker } from "worker_threads";
import { cpus } from "os";
import { fileURLToPath } from "url";
import path from "path";
import type { ScalarGrid, BlockIndex, MarchSegments } from "./marching-squares";

interface TerrainContourJson {
  height: number;
  controlPoints: [number, number][];
}

export interface SimplifyConfig {
  centerLat: number;
  centerLon: number;
  bboxMinLon: number;
  bboxMaxLat: number;
  lonStep: number;
  latStep: number;
  simplifyFeet: number;
  minPerimeterFeet: number;
  minPoints: number;
  scale: number;
  flipY: boolean;
}

function toSharedBuffer(source: ArrayBufferLike): SharedArrayBuffer {
  const shared = new SharedArrayBuffer(source.byteLength);
  new Uint8Array(shared).set(new Uint8Array(source));
  return shared;
}

const BLOCK_SIZE = 64;

const WORKER_EXEC_ARGV = ["--require", "tsx/cjs"];

export class ContourWorkerPool {
  private workers: Worker[];
  private blockCols: number;
  private blockRows: number;

  readonly workerCount: number;

  private constructor(workers: Worker[], blockCols: number, blockRows: number) {
    this.workers = workers;
    this.blockCols = blockCols;
    this.blockRows = blockRows;
    this.workerCount = workers.length;
  }

  static create(grid: ScalarGrid): ContourWorkerPool {
    const { width, height, values, nodataMask } = grid;
    const blockCols = Math.ceil((width - 1) / BLOCK_SIZE);
    const blockRows = Math.ceil((height - 1) / BLOCK_SIZE);

    const numWorkers = Math.min(cpus().length, blockRows);

    const valuesBuffer = toSharedBuffer(values.buffer);
    const nodataBuffer = nodataMask
      ? toSharedBuffer(nodataMask.buffer)
      : new SharedArrayBuffer(0);

    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "workers/contour-worker.ts",
    );

    const workers: Worker[] = [];
    for (let i = 0; i < numWorkers; i++) {
      workers.push(
        new Worker(workerPath, {
          workerData: {
            valuesBuffer,
            nodataBuffer,
            gridWidth: width,
            gridHeight: height,
            hasNodataMask: nodataMask !== undefined,
          },
          execArgv: WORKER_EXEC_ARGV,
        }),
      );
    }

    return new ContourWorkerPool(workers, blockCols, blockRows);
  }

  async buildBlockIndex(): Promise<BlockIndex> {
    const { workers, blockCols, blockRows } = this;
    const numBlocks = blockCols * blockRows;
    const blockMin = new Float64Array(numBlocks);
    const blockMax = new Float64Array(numBlocks);
    const blockHasNoData = new Uint8Array(numBlocks);

    const rowsPerWorker = Math.ceil(blockRows / workers.length);
    const promises: Promise<void>[] = [];

    for (let w = 0; w < workers.length; w++) {
      const blockRowStart = w * rowsPerWorker;
      const blockRowEnd = Math.min(blockRowStart + rowsPerWorker, blockRows);
      if (blockRowStart >= blockRowEnd) break;

      promises.push(
        this.sendAndReceive(w, {
          type: "blockIndex",
          blockCols,
          blockRowStart,
          blockRowEnd,
        }).then((msg) => {
          const dstOffset = blockRowStart * blockCols;
          blockMin.set(new Float64Array(msg.blockMin), dstOffset);
          blockMax.set(new Float64Array(msg.blockMax), dstOffset);
          blockHasNoData.set(new Uint8Array(msg.blockHasNoData), dstOffset);
        }),
      );
    }

    await Promise.all(promises);

    // Share the assembled block index with all workers so march messages stay lightweight
    const sharedMin = toSharedBuffer(blockMin.buffer);
    const sharedMax = toSharedBuffer(blockMax.buffer);
    const sharedND = toSharedBuffer(blockHasNoData.buffer);

    const setPromises: Promise<void>[] = [];
    for (let w = 0; w < workers.length; w++) {
      setPromises.push(
        this.sendAndReceive(w, {
          type: "setBlockIndex",
          blockMinBuffer: sharedMin,
          blockMaxBuffer: sharedMax,
          blockHasNoDataBuffer: sharedND,
        }).then(() => {}),
      );
    }
    await Promise.all(setPromises);

    return { blockCols, blockRows, blockMin, blockMax, blockHasNoData };
  }

  async marchContours(level: number): Promise<MarchSegments> {
    const { workers, blockCols, blockRows } = this;

    const rowsPerWorker = Math.ceil(blockRows / workers.length);
    const promises: Promise<{
      segAx: Float64Array;
      segAy: Float64Array;
      segBx: Float64Array;
      segBy: Float64Array;
      segAEdge: Float64Array;
      segBEdge: Float64Array;
      count: number;
    }>[] = [];

    for (let w = 0; w < workers.length; w++) {
      const blockRowStart = w * rowsPerWorker;
      const blockRowEnd = Math.min(blockRowStart + rowsPerWorker, blockRows);
      if (blockRowStart >= blockRowEnd) break;

      promises.push(
        this.sendAndReceive(w, {
          type: "march",
          level,
          blockCols,
          blockRowStart,
          blockRowEnd,
        }).then((msg) => ({
          segAx: new Float64Array(msg.segAx),
          segAy: new Float64Array(msg.segAy),
          segBx: new Float64Array(msg.segBx),
          segBy: new Float64Array(msg.segBy),
          segAEdge: new Float64Array(msg.segAEdge),
          segBEdge: new Float64Array(msg.segBEdge),
          count: msg.count as number,
        })),
      );
    }

    const results = await Promise.all(promises);

    // Merge segments from all workers using native memcpy
    const totalCount = results.reduce((sum, r) => sum + r.count, 0);
    const segAx = new Float64Array(totalCount);
    const segAy = new Float64Array(totalCount);
    const segBx = new Float64Array(totalCount);
    const segBy = new Float64Array(totalCount);
    const segAEdge = new Float64Array(totalCount);
    const segBEdge = new Float64Array(totalCount);

    let offset = 0;
    for (const r of results) {
      segAx.set(r.segAx.subarray(0, r.count), offset);
      segAy.set(r.segAy.subarray(0, r.count), offset);
      segBx.set(r.segBx.subarray(0, r.count), offset);
      segBy.set(r.segBy.subarray(0, r.count), offset);
      segAEdge.set(r.segAEdge.subarray(0, r.count), offset);
      segBEdge.set(r.segBEdge.subarray(0, r.count), offset);
      offset += r.count;
    }

    return { segAx, segAy, segBx, segBy, segAEdge, segBEdge };
  }

  async setSimplifyConfig(config: SimplifyConfig): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let w = 0; w < this.workers.length; w++) {
      promises.push(
        this.sendAndReceive(w, {
          type: "setSimplifyConfig",
          ...config,
        }).then(() => {}),
      );
    }
    await Promise.all(promises);
  }

  /**
   * Streams rings from a generator to workers for simplification.
   * Each worker pulls the next ring when it finishes its current one,
   * naturally load-balancing across workers.
   */
  /**
   * Streams rings from a generator to workers for simplification.
   * Pulls rings in batches (by point count threshold) to amortize
   * microtask scheduling overhead, while still overlapping ring
   * assembly with worker simplification.
   */
  async simplifyRings(
    rings: Generator<Float64Array>,
    levelFeet: number,
  ): Promise<{ contours: TerrainContourJson[]; ringCount: number }> {
    const { workers } = this;
    const contours: TerrainContourJson[] = [];
    let ringCount = 0;
    let done = false;

    const POINT_THRESHOLD = 2000;

    const pullBatch = (): Float64Array[] => {
      const batch: Float64Array[] = [];
      let totalPoints = 0;
      while (!done) {
        const next = rings.next();
        if (next.done) {
          done = true;
          break;
        }
        ringCount++;
        batch.push(next.value);
        totalPoints += next.value.length / 2;
        if (totalPoints >= POINT_THRESHOLD) break;
      }
      return batch;
    };

    // Pull-based: each worker pulls a batch, sends it, waits for results, repeats
    const workerLoop = (w: number): Promise<void> => {
      const batch = pullBatch();
      if (batch.length === 0) return Promise.resolve();

      const transferList = batch.map((r) => r.buffer as ArrayBuffer);
      return this.sendAndReceive(
        w,
        { type: "simplify", rings: batch, levelFeet },
        transferList,
      ).then((msg) => {
        for (const r of msg.results as TerrainContourJson[]) {
          contours.push(r);
        }
        return workerLoop(w);
      });
    };

    await Promise.all(workers.map((_, w) => workerLoop(w)));
    return { contours, ringCount };
  }

  async shutdown(): Promise<void> {
    const promises = this.workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          worker.on("exit", () => resolve());
          worker.postMessage({ type: "exit" });
        }),
    );
    await Promise.all(promises);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendAndReceive(
    workerIndex: number,
    msg: any,
    transferList?: ArrayBuffer[],
  ): Promise<any> {
    const worker = this.workers[workerIndex];
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (response: any) => {
        worker.off("message", handler);
        worker.off("error", errHandler);
        resolve(response);
      };
      const errHandler = (err: Error) => {
        worker.off("message", handler);
        worker.off("error", errHandler);
        reject(err);
      };
      worker.on("message", handler);
      worker.on("error", errHandler);
      if (transferList) {
        worker.postMessage(msg, transferList);
      } else {
        worker.postMessage(msg);
      }
    });
  }
}
