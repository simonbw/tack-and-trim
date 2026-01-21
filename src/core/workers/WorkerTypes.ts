/**
 * Generic types for the WorkerPool system.
 *
 * These types define the message protocol between the main thread
 * and worker threads for parallel computation.
 */

/**
 * Base interface for all worker requests.
 * Concrete request types should extend this.
 */
export interface WorkerRequest {
  type: "compute";
  batchId: number;
}

/**
 * Progress update from worker to main thread.
 */
export interface WorkerProgress {
  type: "progress";
  batchId: number;
}

/**
 * Base interface for worker results.
 * Concrete result types should extend this.
 */
export interface WorkerResult {
  type: "result";
  batchId: number;
}

/**
 * Error message from worker to main thread.
 */
export interface WorkerError {
  type: "error";
  batchId: number;
  message: string;
}

/**
 * Ready signal sent by worker after initialization.
 */
export interface WorkerReady {
  type: "ready";
}

/**
 * All possible outgoing message types from a worker.
 */
export type WorkerOutgoingMessage<TResult extends WorkerResult> =
  | WorkerProgress
  | TResult
  | WorkerError
  | WorkerReady;
