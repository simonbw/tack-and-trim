/**
 * Worker Pool System
 *
 * Generic infrastructure for parallel computation using Web Workers.
 * Provides a WorkerPool class that handles worker lifecycle, task distribution,
 * progress reporting, and result aggregation.
 */

export {
  WorkerPool,
  distributeWork,
  type WorkerPoolConfig,
  type WorkerRunOptions,
  type WorkerTask,
} from "./WorkerPool";

export {
  type WorkerRequest,
  type WorkerProgress,
  type WorkerResult,
  type WorkerError,
  type WorkerReady,
  type WorkerOutgoingMessage,
} from "./WorkerTypes";
