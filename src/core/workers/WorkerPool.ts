/**
 * Generic Worker Pool
 *
 * Manages a pool of Web Workers for parallel computation.
 * Provides automatic batching, progress reporting, and result aggregation.
 *
 * Usage:
 * ```typescript
 * const pool = new WorkerPool<MyRequest, MyResult>({
 *   workerUrl: new URL('./MyWorker.ts', import.meta.url),
 *   label: 'MyWorker',
 * });
 *
 * await pool.initialize();
 *
 * const task = pool.run({
 *   batches: [request1, request2, ...],
 *   combineResults: (results) => mergedResult,
 *   getTransferables: (req) => [req.data.buffer],
 *   onProgress: (p) => console.log(`Progress: ${p * 100}%`),
 * });
 *
 * const result = await task.promise;
 * ```
 */

import { clamp } from "../util/MathUtil";
import type { WorkerError, WorkerProgress, WorkerResult } from "./WorkerTypes";

/**
 * Configuration for creating a WorkerPool.
 */
export interface WorkerPoolConfig {
  /** URL to the worker script */
  workerUrl: URL;
  /** Label for logging (e.g., "WindWorker") */
  label: string;
  /** Number of workers to create (default: auto-detect based on hardware) */
  workerCount?: number;
  /** Timeout for worker initialization in ms (default: 5000) */
  initTimeout?: number;
}

/**
 * Options for running a parallel computation.
 */
export interface WorkerRunOptions<TRequest, TResult> {
  /** Array of batch requests, one per worker */
  batches: TRequest[];
  /** Function to combine results from all workers into final result */
  combineResults: (results: TResult[]) => TResult;
  /** Optional function to get transferable objects from a request */
  getTransferables?: (request: TRequest) => Transferable[];
  /** Optional progress callback (0-1) */
  onProgress?: (progress: number) => void;
}

/**
 * Handle returned from WorkerPool.run() for tracking a computation task.
 */
export interface WorkerTask<TResult> {
  /** Current progress from 0 to 1 */
  progress: number;
  /** Promise that resolves with the combined result */
  promise: Promise<TResult>;
}

/**
 * Get the recommended number of workers based on hardware concurrency.
 * Uses (cores - 1) to leave one core for the main thread,
 * clamped to [2, 8] for reasonable bounds.
 */
function getRecommendedWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return clamp(cores - 1, 2, 8);
}

/**
 * Generic pool of Web Workers for parallel computation.
 *
 * Features:
 * - Automatic worker count detection based on hardware
 * - Worker initialization with ready signal
 * - Batch distribution across workers
 * - Progress reporting aggregation
 * - Transferable object support for zero-copy
 * - Error handling with worker-specific context
 */
export class WorkerPool<
  TRequest extends { type: string; batchId: number },
  TResult extends WorkerResult,
> {
  private config: Required<WorkerPoolConfig>;
  private workers: Worker[] = [];
  private ready = false;
  private initializing = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: WorkerPoolConfig) {
    this.config = {
      workerCount: config.workerCount ?? getRecommendedWorkerCount(),
      initTimeout: config.initTimeout ?? 5000,
      ...config,
    };
  }

  /**
   * Initialize the worker pool.
   * Creates workers and waits for all to signal ready.
   * Safe to call multiple times - will return existing promise if already initializing.
   */
  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.initializing && this.initPromise) {
      return this.initPromise;
    }

    this.initializing = true;
    const { workerUrl, workerCount, initTimeout, label } = this.config;

    console.log(`[${label}] Initializing ${workerCount} workers...`);

    const workers: Worker[] = [];
    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl, { type: "module" });

      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`${label} worker ${i} timed out during init`));
        }, initTimeout);

        const handler = (event: MessageEvent) => {
          if (event.data?.type === "ready") {
            clearTimeout(timeout);
            worker.removeEventListener("message", handler);
            resolve();
          }
        };

        worker.addEventListener("message", handler);
        worker.addEventListener("error", (e) => {
          clearTimeout(timeout);
          reject(new Error(`${label} worker ${i} error: ${e.message}`));
        });
      });

      workers.push(worker);
      readyPromises.push(readyPromise);
    }

    this.initPromise = Promise.all(readyPromises).then(() => {
      this.workers = workers;
      this.ready = true;
      this.initializing = false;
      console.log(`[${label}] ${workers.length} workers ready`);
    });

    return this.initPromise;
  }

  /**
   * Terminate all workers in the pool.
   * Frees resources. Pool cannot be used after termination.
   */
  terminate(): void {
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    this.ready = false;
    this.initializing = false;
    this.initPromise = null;
    console.log(`[${this.config.label}] Workers terminated`);
  }

  /**
   * Check if the worker pool is ready for computation.
   */
  isReady(): boolean {
    return this.ready && this.workers.length > 0;
  }

  /**
   * Get the number of workers in the pool.
   */
  getWorkerCount(): number {
    return this.workers.length;
  }

  /**
   * Run a parallel computation across all workers.
   *
   * @param options - Configuration for the computation
   * @returns Task handle with progress property and promise
   */
  run(options: WorkerRunOptions<TRequest, TResult>): WorkerTask<TResult> {
    const task: WorkerTask<TResult> = {
      progress: 0,
      promise: null!,
    };

    task.promise = this.runAsync(options, (p) => {
      task.progress = p;
    });

    return task;
  }

  /**
   * Internal async implementation of run().
   */
  private async runAsync(
    options: WorkerRunOptions<TRequest, TResult>,
    setProgress: (progress: number) => void,
  ): Promise<TResult> {
    // Ensure workers are ready
    if (!this.isReady()) {
      await this.initialize();
    }

    const { batches, combineResults, getTransferables, onProgress } = options;
    const batchId = Date.now();

    // Track progress across all batches
    const batchCount = batches.length;
    const batchProgress = new Array<number>(batchCount).fill(0);

    const updateProgress = () => {
      const total = batchProgress.reduce((sum, p) => sum + p, 0) / batchCount;
      setProgress(total);
      onProgress?.(total);
    };

    // Create promises for each batch
    const resultPromises = batches.map((batch, index) => {
      if (index >= this.workers.length) {
        // More batches than workers shouldn't happen if caller uses distributeWork()
        // but handle it gracefully
        return Promise.resolve(null as TResult | null);
      }

      const worker = this.workers[index];

      return new Promise<TResult>((resolve, reject) => {
        const messageHandler = (
          event: MessageEvent<WorkerProgress | TResult | WorkerError>,
        ) => {
          const msg = event.data;
          if ("batchId" in msg && msg.batchId !== batchId) return;

          if (msg.type === "progress") {
            batchProgress[index] =
              (msg as WorkerProgress & { batchProgress?: number })
                .batchProgress ?? batchProgress[index] + 0.1;
            updateProgress();
          } else if (msg.type === "result") {
            batchProgress[index] = 1;
            updateProgress();
            worker.removeEventListener("message", messageHandler);
            resolve(msg as TResult);
          } else if (msg.type === "error") {
            worker.removeEventListener("message", messageHandler);
            reject(new Error((msg as WorkerError).message));
          }
        };

        worker.addEventListener("message", messageHandler);

        // Add batchId to the request
        const request = { ...batch, batchId };

        // Get transferables if provided
        const transferables = getTransferables?.(batch) ?? [];

        worker.postMessage(request, transferables);
      });
    });

    // Wait for all results
    const allResults = await Promise.all(resultPromises);
    const results = allResults.filter((r) => r !== null) as TResult[];

    // Combine results
    return combineResults(results);
  }
}

/**
 * Distribute items evenly among workers.
 *
 * @param items - Array of items to distribute
 * @param workerCount - Number of workers
 * @returns Array of arrays, one per worker, containing assigned items
 */
export function distributeWork<T>(items: T[], workerCount: number): T[][] {
  const batches: T[][] = Array.from({ length: workerCount }, () => []);

  for (let i = 0; i < items.length; i++) {
    batches[i % workerCount].push(items[i]);
  }

  return batches;
}
