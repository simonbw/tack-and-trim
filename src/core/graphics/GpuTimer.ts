import { profiler } from "../util/Profiler";

/** WebGL2 timer query extension interface */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  TIMESTAMP_EXT: number;
  GPU_DISJOINT_EXT: number;
  QUERY_COUNTER_BITS_EXT: number;
}

/**
 * GPU timing utility using EXT_disjoint_timer_query_webgl2.
 * Measures GPU execution time for rendering operations.
 */
export class GpuTimer {
  private timerQueryExt: TimerQueryExt | null = null;
  private enabled: boolean = false;
  private pendingQueries: Array<{
    query: WebGLQuery;
    label: string;
  }> = [];

  constructor(private gl: WebGL2RenderingContext) {
    // Try to get GPU timer extension
    this.timerQueryExt = gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    ) as TimerQueryExt | null;
    if (this.timerQueryExt) {
      console.log("GPU timer query extension available");
    }
  }

  /** Check if GPU timer extension is available */
  hasSupport(): boolean {
    return this.timerQueryExt !== null;
  }

  /** Enable or disable GPU timing */
  setEnabled(enabled: boolean): void {
    if (enabled && !this.timerQueryExt) {
      console.warn("GPU timer extension not available");
      return;
    }
    this.enabled = enabled;
  }

  /** Check if GPU timing is enabled */
  isEnabled(): boolean {
    return this.enabled && this.timerQueryExt !== null;
  }

  /** Debug: get GPU timing status */
  getDebugInfo(): {
    extensionAvailable: boolean;
    enabled: boolean;
    pendingQueries: number;
  } {
    return {
      extensionAvailable: this.timerQueryExt !== null,
      enabled: this.enabled,
      pendingQueries: this.pendingQueries.length,
    };
  }

  /** Begin a GPU-timed section */
  begin(label: string): void {
    if (!this.enabled || !this.timerQueryExt) return;

    const gl = this.gl;
    const ext = this.timerQueryExt;

    // Create and begin query
    const query = gl.createQuery();
    if (!query) return;

    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.pendingQueries.push({ query, label });
  }

  /** End the current GPU-timed section */
  end(): void {
    if (!this.enabled || !this.timerQueryExt) return;

    const gl = this.gl;
    const ext = this.timerQueryExt;

    gl.endQuery(ext.TIME_ELAPSED_EXT);
  }

  /**
   * Poll for completed GPU timer queries and report results to profiler.
   * Call this at the end of each frame.
   */
  poll(): void {
    if (!this.timerQueryExt) return;

    const gl = this.gl;
    const ext = this.timerQueryExt;

    // Check for GPU disjoint - if true, all results are invalid
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      // Discard all pending queries
      for (const { query } of this.pendingQueries) {
        gl.deleteQuery(query);
      }
      this.pendingQueries = [];
      return;
    }

    // Process completed queries
    const stillPending: typeof this.pendingQueries = [];

    for (const { query, label } of this.pendingQueries) {
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);

      if (available) {
        const timeNs = gl.getQueryParameter(query, gl.QUERY_RESULT);
        const timeMs = timeNs / 1_000_000;

        // Report to profiler using explicit elapsed time
        profiler.start(label);
        profiler.end(label, timeMs);

        gl.deleteQuery(query);
      } else {
        // Keep for next poll
        stillPending.push({ query, label });
      }
    }

    this.pendingQueries = stillPending;
  }

  /** Clean up all pending queries */
  destroy(): void {
    const gl = this.gl;
    for (const { query } of this.pendingQueries) {
      gl.deleteQuery(query);
    }
    this.pendingQueries = [];
  }
}
