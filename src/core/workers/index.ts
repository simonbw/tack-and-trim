/**
 * Worker Pool System
 *
 * Generic request/response infrastructure for computation using Web Workers.
 */

export {
  WorkerPool,
  type WorkerPoolConfig,
  type SubmitRequestOptions,
  type SubmitManyOptions,
  type SubmitManySuccess,
  type SubmitManyFailure,
  type SubmitManyResult,
} from "./WorkerPool";

export {
  type WorkerRequestMessage,
  type WorkerRequestResult,
  type WorkerRequestError,
} from "./WorkerTypes";
