interface ProfileEntry {
  calls: number;
  totalMs: number;
  maxMs: number;
  startTime?: number;
}

export interface ProfileStats {
  label: string;
  calls: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

/**
 * Simple profiler for measuring code performance.
 *
 * Usage:
 *   profiler.start("myFunction");
 *   // ... code to measure ...
 *   profiler.end("myFunction");
 *
 *   // Or use measure() for cleaner code:
 *   profiler.measure("myFunction", () => { ... });
 *
 *   // Just count calls without timing:
 *   profiler.count("frequentOperation");
 *
 *   // View results:
 *   profiler.report();
 *   profiler.reset();
 */
class Profiler {
  private entries = new Map<string, ProfileEntry>();
  private enabled = true;

  /** Start timing a labeled section */
  start(label: string): void {
    if (!this.enabled) return;
    const entry = this.getOrCreate(label);
    entry.startTime = performance.now();
  }

  /** End timing a labeled section */
  end(label: string): void {
    if (!this.enabled) return;
    const entry = this.entries.get(label);
    if (!entry || entry.startTime === undefined) return;

    const elapsed = performance.now() - entry.startTime;
    entry.calls++;
    entry.totalMs += elapsed;
    entry.maxMs = Math.max(entry.maxMs, elapsed);
    entry.startTime = undefined;
  }

  /** Measure a function's execution time */
  measure<T>(label: string, fn: () => T): T {
    this.start(label);
    try {
      return fn();
    } finally {
      this.end(label);
    }
  }

  /** Just count occurrences (no timing overhead) */
  count(label: string): void {
    if (!this.enabled) return;
    const entry = this.getOrCreate(label);
    entry.calls++;
  }

  /** Log a formatted report to console */
  report(): void {
    console.log("=== Profiler Report ===");
    const sorted = [...this.entries.entries()].sort(
      (a, b) => b[1].totalMs - a[1].totalMs
    );
    for (const [label, entry] of sorted) {
      const avg = entry.calls > 0 ? entry.totalMs / entry.calls : 0;
      if (entry.totalMs > 0) {
        console.log(
          `${label.padEnd(30)} calls: ${entry.calls.toString().padStart(7)}  ` +
            `total: ${entry.totalMs.toFixed(1).padStart(8)}ms  ` +
            `avg: ${avg.toFixed(3).padStart(8)}ms  ` +
            `max: ${entry.maxMs.toFixed(2).padStart(7)}ms`
        );
      } else {
        console.log(
          `${label.padEnd(30)} calls: ${entry.calls.toString().padStart(7)}  (count only)`
        );
      }
    }
    console.log("========================");
  }

  /** Clear all stats */
  reset(): void {
    this.entries.clear();
  }

  /** Enable/disable profiling (disabled = no overhead) */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Check if profiling is enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Get all stats sorted by total time (descending) */
  getStats(): ProfileStats[] {
    return [...this.entries.entries()]
      .map(([label, entry]) => ({
        label,
        calls: entry.calls,
        totalMs: entry.totalMs,
        avgMs: entry.calls > 0 ? entry.totalMs / entry.calls : 0,
        maxMs: entry.maxMs,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Get top N stats by total time */
  getTopStats(n: number): ProfileStats[] {
    return this.getStats().slice(0, n);
  }

  private getOrCreate(label: string): ProfileEntry {
    let entry = this.entries.get(label);
    if (!entry) {
      entry = { calls: 0, totalMs: 0, maxMs: 0 };
      this.entries.set(label, entry);
    }
    return entry;
  }
}

export const profiler = new Profiler();
