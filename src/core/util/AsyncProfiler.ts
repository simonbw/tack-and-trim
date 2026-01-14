import { lerp } from "./MathUtil";

/**
 * Timing data for a single in-flight async operation.
 */
interface AsyncOperationTiming {
  startTime: number;
  startFrame: number;
}

/**
 * Token returned by startAsync for manual tracking.
 */
export interface AsyncOperationToken {
  label: string;
  timing: AsyncOperationTiming | null;
}

/**
 * Per-frame accumulated data for async operations.
 */
interface AsyncFrameAccumulator {
  completions: number;
  callbackMs: number;
  maxCallbackMs: number;
  totalLatencyMs: number;
}

/**
 * Internal entry tracking async operations for a given label.
 */
interface AsyncProfileEntry {
  frame: AsyncFrameAccumulator;
  smoothedCompletionsPerFrame: number;
  smoothedCallbackMsPerFrame: number;
  smoothedMaxCallbackMs: number;
  smoothedLatencyMs: number;
  inFlight: AsyncOperationTiming[];
  peakCallbackMs: number;
  peakLatencyMs: number;
  peakInFlight: number;
}

/**
 * Stats returned for display in the UI.
 */
export interface AsyncProfileStats {
  label: string;
  /** Average callback CPU time per frame (ms) - this affects FPS */
  callbackMsPerFrame: number;
  /** Average number of completions per frame */
  completionsPerFrame: number;
  /** Average latency from start to completion (ms) */
  avgLatencyMs: number;
  /** Current number of in-flight operations */
  inFlightCount: number;
  /** Peak callback time observed */
  peakCallbackMs: number;
  /** Peak latency observed */
  peakLatencyMs: number;
  /** Peak concurrent in-flight operations */
  peakInFlight: number;
}

/**
 * Profiler for tracking async operation callback CPU time.
 *
 * Key distinction from regular profiler:
 * - Regular profiler tracks synchronous code execution within a frame
 * - AsyncProfiler tracks callback CPU time that runs on the main thread
 *   but happens at unpredictable times (between frames, during yield points)
 *
 * The callback CPU time DOES affect FPS because it runs on the main thread.
 *
 * Usage:
 *   // Wrap a promise-returning operation
 *   const result = await asyncProfiler.measureAsync("GPU.mapAsync",
 *     () => buffer.mapAsync(GPUMapMode.READ)
 *   );
 *
 *   // Or wrap just the callback
 *   buffer.mapAsync(GPUMapMode.READ).then(
 *     asyncProfiler.wrapCallback("GPU.processData", () => {
 *       // process mapped data
 *     })
 *   );
 */
class AsyncProfiler {
  private entries = new Map<string, AsyncProfileEntry>();
  private enabled = true;
  private currentFrame = 0;

  private readonly smoothing = 0.975;

  /**
   * Wrap an async operation to track its callback CPU time.
   * Tracks both the latency (start to completion) and callback time.
   */
  measureAsync<T>(label: string, asyncFn: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      return asyncFn();
    }

    const entry = this.getOrCreate(label);
    const timing: AsyncOperationTiming = {
      startTime: performance.now(),
      startFrame: this.currentFrame,
    };

    entry.inFlight.push(timing);
    entry.peakInFlight = Math.max(entry.peakInFlight, entry.inFlight.length);

    return asyncFn().then(
      (result) => {
        this.recordCompletion(label, timing);
        return result;
      },
      (error) => {
        this.recordCompletion(label, timing);
        throw error;
      },
    );
  }

  /**
   * Wrap a callback function to track its CPU time.
   * Use this when you can't use measureAsync directly,
   * or when you only want to track the callback without latency.
   */
  wrapCallback<TArgs extends unknown[], TReturn>(
    label: string,
    callback: (...args: TArgs) => TReturn,
  ): (...args: TArgs) => TReturn {
    if (!this.enabled) {
      return callback;
    }

    const entry = this.getOrCreate(label);

    return (...args: TArgs): TReturn => {
      const callbackStart = performance.now();
      try {
        return callback(...args);
      } finally {
        const elapsed = performance.now() - callbackStart;
        entry.frame.completions++;
        entry.frame.callbackMs += elapsed;
        entry.frame.maxCallbackMs = Math.max(
          entry.frame.maxCallbackMs,
          elapsed,
        );
        entry.peakCallbackMs = Math.max(entry.peakCallbackMs, elapsed);
      }
    };
  }

  /**
   * Start tracking an async operation manually.
   * Call endAsync when the callback completes.
   */
  startAsync(label: string): AsyncOperationToken {
    if (!this.enabled) {
      return { label, timing: null };
    }

    const entry = this.getOrCreate(label);
    const timing: AsyncOperationTiming = {
      startTime: performance.now(),
      startFrame: this.currentFrame,
    };

    entry.inFlight.push(timing);
    entry.peakInFlight = Math.max(entry.peakInFlight, entry.inFlight.length);

    return { label, timing };
  }

  /**
   * End tracking an async operation and record timing.
   * The elapsed time since the token was created becomes the callback time.
   */
  endAsync(token: AsyncOperationToken): void {
    if (!this.enabled || !token.timing) return;
    this.recordCompletion(token.label, token.timing);
  }

  /**
   * Called by the main profiler when a frame ends.
   * Updates smoothed values and resets frame accumulators.
   */
  endFrame(): void {
    this.currentFrame++;

    for (const entry of this.entries.values()) {
      entry.smoothedCompletionsPerFrame = lerp(
        entry.frame.completions,
        entry.smoothedCompletionsPerFrame,
        this.smoothing,
      );
      entry.smoothedCallbackMsPerFrame = lerp(
        entry.frame.callbackMs,
        entry.smoothedCallbackMsPerFrame,
        this.smoothing,
      );
      entry.smoothedMaxCallbackMs = lerp(
        entry.frame.maxCallbackMs,
        entry.smoothedMaxCallbackMs,
        this.smoothing,
      );

      const avgLatency =
        entry.frame.completions > 0
          ? entry.frame.totalLatencyMs / entry.frame.completions
          : entry.smoothedLatencyMs;
      entry.smoothedLatencyMs = lerp(
        avgLatency,
        entry.smoothedLatencyMs,
        this.smoothing,
      );

      entry.frame = {
        completions: 0,
        callbackMs: 0,
        maxCallbackMs: 0,
        totalLatencyMs: 0,
      };
    }
  }

  /**
   * Get all async profile stats for display, sorted by callback time.
   */
  getStats(): AsyncProfileStats[] {
    const stats: AsyncProfileStats[] = [];

    for (const [label, entry] of this.entries) {
      stats.push({
        label,
        callbackMsPerFrame: entry.smoothedCallbackMsPerFrame,
        completionsPerFrame: entry.smoothedCompletionsPerFrame,
        avgLatencyMs: entry.smoothedLatencyMs,
        inFlightCount: entry.inFlight.length,
        peakCallbackMs: entry.peakCallbackMs,
        peakLatencyMs: entry.peakLatencyMs,
        peakInFlight: entry.peakInFlight,
      });
    }

    stats.sort((a, b) => b.callbackMsPerFrame - a.callbackMsPerFrame);
    return stats;
  }

  /**
   * Get total callback CPU time per frame across all async operations.
   */
  getTotalCallbackMs(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.smoothedCallbackMsPerFrame;
    }
    return total;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.entries.clear();
  }

  private recordCompletion(label: string, timing: AsyncOperationTiming): void {
    const entry = this.entries.get(label);
    if (!entry) return;

    const idx = entry.inFlight.indexOf(timing);
    if (idx >= 0) {
      entry.inFlight.splice(idx, 1);
    }

    const now = performance.now();
    const callbackMs = now - timing.startTime;
    const latencyMs = callbackMs;

    entry.frame.completions++;
    entry.frame.callbackMs += callbackMs;
    entry.frame.maxCallbackMs = Math.max(entry.frame.maxCallbackMs, callbackMs);
    entry.frame.totalLatencyMs += latencyMs;

    entry.peakCallbackMs = Math.max(entry.peakCallbackMs, callbackMs);
    entry.peakLatencyMs = Math.max(entry.peakLatencyMs, latencyMs);
  }

  private getOrCreate(label: string): AsyncProfileEntry {
    let entry = this.entries.get(label);
    if (!entry) {
      entry = {
        frame: {
          completions: 0,
          callbackMs: 0,
          maxCallbackMs: 0,
          totalLatencyMs: 0,
        },
        smoothedCompletionsPerFrame: 0,
        smoothedCallbackMsPerFrame: 0,
        smoothedMaxCallbackMs: 0,
        smoothedLatencyMs: 0,
        inFlight: [],
        peakCallbackMs: 0,
        peakLatencyMs: 0,
        peakInFlight: 0,
      };
      this.entries.set(label, entry);
    }
    return entry;
  }
}

export const asyncProfiler = new AsyncProfiler();
