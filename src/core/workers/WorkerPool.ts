import { clamp } from "../util/MathUtil";
import type {
  WorkerRequestError,
  WorkerRequestResult,
} from "./WorkerTypes";

/**
 * Configuration for creating a WorkerPool.
 */
export interface WorkerPoolConfig {
  /** URL to the worker script */
  workerUrl: URL;
  /** Label for logging and errors */
  label: string;
  /** Number of workers to create (default: auto-detect based on hardware) */
  workerCount?: number;
  /** Timeout for worker initialization in ms (default: 5000) */
  initTimeoutMs?: number;
  /** Default timeout for each request in ms (default: 30000) */
  defaultRequestTimeoutMs?: number;
}

/**
 * Options for a single submitted request.
 */
export interface SubmitRequestOptions {
  /** Transferable objects to send alongside the request */
  transferables?: Transferable[];
  /** Timeout override in ms */
  timeoutMs?: number;
}

/**
 * Options for submitting multiple requests.
 */
export interface SubmitManyOptions<TRequest> {
  /** Continue processing other requests if one fails */
  continueOnError?: boolean;
  /** Timeout override in ms for every request */
  timeoutMs?: number;
  /** Optional transferable resolver for each request */
  getTransferables?: (
    request: TRequest,
    index: number,
  ) => Transferable[] | undefined;
}

export interface SubmitManySuccess<TRequest, TResult> {
  request: TRequest;
  response: TResult;
}

export interface SubmitManyFailure<TRequest> {
  request: TRequest;
  error: Error;
}

export interface SubmitManyResult<TRequest, TResult> {
  successes: Array<SubmitManySuccess<TRequest, TResult>>;
  failures: Array<SubmitManyFailure<TRequest>>;
}

interface PendingRequest<TRequest, TResult> {
  request: TRequest;
  transferables: Transferable[];
  timeoutMs: number;
  resolve: (result: TResult) => void;
  reject: (error: Error) => void;
}

/**
 * Get a recommended worker count based on hardware concurrency.
 */
function getRecommendedWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return clamp(cores - 1, 1, 8);
}

/**
 * Request-oriented worker pool.
 *
 * - Caller submits individual requests and awaits individual responses.
 * - Pool manages queueing and worker load balancing internally.
 */
export class WorkerPool<
  TRequest extends { type: string; requestId: number },
  TResult extends WorkerRequestResult,
> {
  private config: Required<WorkerPoolConfig>;
  private workers: Worker[] = [];
  private inFlightByWorker = new Map<number, PendingRequest<TRequest, TResult>>();
  private timeoutByRequestId = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingQueue: PendingRequest<TRequest, TResult>[] = [];
  private ready = false;
  private initializing = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: WorkerPoolConfig) {
    this.config = {
      workerCount: config.workerCount ?? getRecommendedWorkerCount(),
      initTimeoutMs: config.initTimeoutMs ?? 5000,
      defaultRequestTimeoutMs: config.defaultRequestTimeoutMs ?? 30000,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.initializing && this.initPromise) {
      return this.initPromise;
    }

    this.initializing = true;
    this.initPromise = this.initializeWorkers().catch((error) => {
      this.initializing = false;
      this.initPromise = null;
      this.ready = false;
      throw error;
    });
    return this.initPromise;
  }

  terminate(): void {
    for (const timer of this.timeoutByRequestId.values()) {
      clearTimeout(timer);
    }
    this.timeoutByRequestId.clear();

    for (const [workerIndex, pending] of this.inFlightByWorker.entries()) {
      pending.reject(
        new Error(
          `${this.config.label} worker ${workerIndex} terminated while request ${pending.request.requestId} was in flight`,
        ),
      );
    }
    this.inFlightByWorker.clear();

    for (const pending of this.pendingQueue) {
      pending.reject(
        new Error(
          `${this.config.label} terminated before request ${pending.request.requestId} could be processed`,
        ),
      );
    }
    this.pendingQueue = [];

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.ready = false;
    this.initializing = false;
    this.initPromise = null;
  }

  isReady(): boolean {
    return this.ready && this.workers.length > 0;
  }

  getWorkerCount(): number {
    return this.workers.length;
  }

  async submitRequest(
    request: TRequest,
    options?: SubmitRequestOptions,
  ): Promise<TResult> {
    if (!this.isReady()) {
      await this.initialize();
    }

    const transferables = options?.transferables ?? [];
    const timeoutMs = options?.timeoutMs ?? this.config.defaultRequestTimeoutMs;

    return new Promise<TResult>((resolve, reject) => {
      this.pendingQueue.push({
        request,
        transferables,
        timeoutMs,
        resolve,
        reject,
      });
      this.dispatchPendingRequests();
    });
  }

  async submitMany(
    requests: TRequest[],
    options?: SubmitManyOptions<TRequest>,
  ): Promise<SubmitManyResult<TRequest, TResult>> {
    const continueOnError = options?.continueOnError ?? false;
    const getTransferables = options?.getTransferables;

    if (!continueOnError) {
      const responses = await Promise.all(
        requests.map((request, index) =>
          this.submitRequest(request, {
            timeoutMs: options?.timeoutMs,
            transferables: getTransferables?.(request, index),
          }),
        ),
      );
      return {
        successes: requests.map((request, index) => ({
          request,
          response: responses[index],
        })),
        failures: [],
      };
    }

    const settled = await Promise.all(
      requests.map(async (request, index) => {
        try {
          const response = await this.submitRequest(request, {
            timeoutMs: options?.timeoutMs,
            transferables: getTransferables?.(request, index),
          });
          return { request, response, error: null as Error | null };
        } catch (error) {
          const requestError =
            error instanceof Error ? error : new Error(String(error));
          return { request, response: null as TResult | null, error: requestError };
        }
      }),
    );

    const successes: Array<SubmitManySuccess<TRequest, TResult>> = [];
    const failures: Array<SubmitManyFailure<TRequest>> = [];

    for (const entry of settled) {
      if (entry.error) {
        failures.push({ request: entry.request, error: entry.error });
      } else if (entry.response) {
        successes.push({ request: entry.request, response: entry.response });
      }
    }

    return { successes, failures };
  }

  private async initializeWorkers(): Promise<void> {
    const { workerUrl, workerCount, initTimeoutMs, label } = this.config;
    const workers: Worker[] = [];
    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerUrl, { type: "module" });
      workers.push(worker);

      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`${label} worker ${i} timed out during init`));
        }, initTimeoutMs);

        const readyHandler = (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: string };
          if (data?.type === "ready") {
            clearTimeout(timeout);
            worker.removeEventListener("message", readyHandler);
            worker.removeEventListener("error", initErrorHandler);
            resolve();
          }
        };

        const initErrorHandler = (event: ErrorEvent) => {
          clearTimeout(timeout);
          worker.removeEventListener("message", readyHandler);
          worker.removeEventListener("error", initErrorHandler);
          reject(new Error(`${label} worker ${i} error: ${event.message}`));
        };

        worker.addEventListener("message", readyHandler);
        worker.addEventListener("error", initErrorHandler);
      });

      readyPromises.push(readyPromise);
    }

    try {
      await Promise.all(readyPromises);
    } catch (error) {
      for (const worker of workers) {
        worker.terminate();
      }
      throw error;
    }

    this.workers = workers;
    this.ready = true;
    this.initializing = false;

    for (let i = 0; i < this.workers.length; i++) {
      const worker = this.workers[i];
      worker.addEventListener("message", (event) => {
        this.onWorkerMessage(i, event);
      });
      worker.addEventListener("error", (event) => {
        this.onWorkerError(i, event);
      });
    }

    this.dispatchPendingRequests();
  }

  private dispatchPendingRequests(): void {
    if (!this.isReady()) {
      return;
    }

    for (let i = 0; i < this.workers.length; i++) {
      if (this.inFlightByWorker.has(i)) {
        continue;
      }

      const pending = this.pendingQueue.shift();
      if (!pending) {
        break;
      }

      this.inFlightByWorker.set(i, pending);
      const timeout = setTimeout(() => {
        this.onRequestTimeout(i, pending.request.requestId);
      }, pending.timeoutMs);
      this.timeoutByRequestId.set(pending.request.requestId, timeout);

      try {
        this.workers[i].postMessage(pending.request, pending.transferables);
      } catch (error) {
        this.clearInFlight(i, pending.request.requestId);
        pending.reject(
          new Error(
            `${this.config.label} worker ${i} failed to post request ${pending.request.requestId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        this.dispatchPendingRequests();
      }
    }
  }

  private onWorkerMessage(workerIndex: number, event: MessageEvent<unknown>): void {
    const data = event.data as
      | { type?: string; requestId?: number; message?: string }
      | undefined;
    if (!data) {
      return;
    }

    if (data.type === "ready") {
      return;
    }

    if (typeof data.requestId !== "number") {
      return;
    }

    const pending = this.inFlightByWorker.get(workerIndex);
    if (!pending || pending.request.requestId !== data.requestId) {
      return;
    }

    if (data.type === "result") {
      this.clearInFlight(workerIndex, data.requestId);
      pending.resolve(data as TResult);
      this.dispatchPendingRequests();
      return;
    }

    if (data.type === "error") {
      const message =
        (data as WorkerRequestError).message || "Worker reported an error";
      this.clearInFlight(workerIndex, data.requestId);
      pending.reject(
        new Error(
          `${this.config.label} worker ${workerIndex} request ${data.requestId} failed: ${message}`,
        ),
      );
      this.dispatchPendingRequests();
    }
  }

  private onWorkerError(workerIndex: number, event: ErrorEvent): void {
    const pending = this.inFlightByWorker.get(workerIndex);
    if (!pending) {
      return;
    }

    const requestId = pending.request.requestId;
    this.clearInFlight(workerIndex, requestId);
    pending.reject(
      new Error(
        `${this.config.label} worker ${workerIndex} crashed while processing request ${requestId}: ${event.message}`,
      ),
    );
    this.dispatchPendingRequests();
  }

  private onRequestTimeout(workerIndex: number, requestId: number): void {
    const pending = this.inFlightByWorker.get(workerIndex);
    if (!pending || pending.request.requestId !== requestId) {
      return;
    }

    this.clearInFlight(workerIndex, requestId);
    pending.reject(
      new Error(
        `${this.config.label} worker ${workerIndex} timed out processing request ${requestId}`,
      ),
    );
    this.dispatchPendingRequests();
  }

  private clearInFlight(workerIndex: number, requestId: number): void {
    this.inFlightByWorker.delete(workerIndex);

    const timeout = this.timeoutByRequestId.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeoutByRequestId.delete(requestId);
    }
  }
}
