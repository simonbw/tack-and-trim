/**
 * Generic types for request/response worker pools.
 */

/**
 * Base request shape for request-oriented worker pools.
 */
export interface WorkerRequestMessage {
  type: string;
  requestId: number;
}

/**
 * Base success result shape for request-oriented worker pools.
 */
export interface WorkerRequestResult {
  type: "result";
  requestId: number;
}

/**
 * Base error result shape for request-oriented worker pools.
 */
export interface WorkerRequestError {
  type: "error";
  requestId: number;
  message: string;
}
