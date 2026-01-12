import { lerp } from "./MathUtil";

interface ProfileEntry {
  // Per-frame accumulators (reset each frame)
  frameCalls: number;
  frameMs: number;

  // Smoothed per-frame values (for display)
  smoothedCallsPerFrame: number;
  smoothedMsPerFrame: number;

  // Other fields
  maxMs: number;
  startTime?: number;
}

export interface ProfileStats {
  label: string;
  shortLabel: string;
  depth: number;
  callsPerFrame: number;
  msPerFrame: number;
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

  // Stack tracking
  private stack: string[] = [];
  private pathCache = new Map<string, string>();
  private readonly separator = " > ";
  private readonly maxStackDepth = 10;

  // Smoothing factor (higher = smoother, slower to respond)
  private readonly smoothing = 0.975;

  // Stats caching - invalidated each frame
  private cachedStats: ProfileStats[] | null = null;
  private cachedStatsParams: { maxChildren?: number } | null = null;

  /** Get the current stack as a path string (cached) */
  private getCurrentPath(): string {
    if (this.stack.length === 0) return "";
    const cacheKey = this.stack.join("\0");
    let path = this.pathCache.get(cacheKey);
    if (!path) {
      path = this.stack.join(this.separator);
      this.pathCache.set(cacheKey, path);
    }
    return path;
  }

  /** Get the entry key for a label using current stack context */
  private getEntryKey(label: string): string {
    const currentPath = this.getCurrentPath();
    if (currentPath === "") return label;
    const cacheKey = currentPath + "\0" + label;
    let fullPath = this.pathCache.get(cacheKey);
    if (!fullPath) {
      fullPath = currentPath + this.separator + label;
      this.pathCache.set(cacheKey, fullPath);
    }
    return fullPath;
  }

  /** Start timing a labeled section */
  start(label: string): void {
    if (!this.enabled) return;
    if (this.stack.length >= this.maxStackDepth) {
      console.warn(
        `Profiler: max stack depth (${this.maxStackDepth}) exceeded, ignoring: ${label}`,
      );
      return;
    }
    const entryKey = this.getEntryKey(label);
    const entry = this.getOrCreate(entryKey);
    entry.startTime = performance.now();
    this.stack.push(label);
  }

  /** End timing a labeled section. Optionally pass explicit elapsed time. */
  end(label: string, explicitElapsedMs?: number): void {
    if (!this.enabled) return;
    if (this.stack.length === 0) {
      console.warn(`Profiler: end("${label}") called with empty stack`);
      return;
    }
    const expectedLabel = this.stack[this.stack.length - 1];
    if (expectedLabel !== label) {
      console.warn(
        `Profiler: mismatched end - expected "${expectedLabel}", got "${label}"`,
      );
      return;
    }
    // Pop the stack to restore parent context
    this.stack.pop();
    // Get the entry key (now with the label as child of current stack)
    const entryKey = this.getEntryKey(label);
    const entry = this.entries.get(entryKey);
    if (!entry) return;

    const elapsed =
      explicitElapsedMs !== undefined
        ? explicitElapsedMs
        : entry.startTime !== undefined
          ? performance.now() - entry.startTime
          : 0;
    entry.frameCalls++;
    entry.frameMs += elapsed;
    entry.maxMs = Math.max(entry.maxMs, elapsed);
    entry.startTime = undefined;

    // Trigger frame end processing when the root "Game.loop" label ends
    if (this.stack.length === 0 && label === "Game.loop") {
      this.endFrame();
    }
  }

  /** Process end of frame - update smoothed values and reset accumulators */
  private endFrame(): void {
    // Invalidate stats cache
    this.cachedStats = null;
    this.cachedStatsParams = null;

    for (const entry of this.entries.values()) {
      // Update smoothed values with exponential moving average
      entry.smoothedCallsPerFrame = lerp(
        entry.frameCalls,
        entry.smoothedCallsPerFrame,
        this.smoothing,
      );
      entry.smoothedMsPerFrame = lerp(
        entry.frameMs,
        entry.smoothedMsPerFrame,
        this.smoothing,
      );

      // Reset frame accumulators
      entry.frameCalls = 0;
      entry.frameMs = 0;
    }
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
  count(label: string, amount: number = 1): void {
    if (!this.enabled) return;
    const entryKey = this.getEntryKey(label);
    const entry = this.getOrCreate(entryKey);
    entry.frameCalls += amount;
  }

  /** Log a formatted report to console */
  report(): void {
    console.log("=== Profiler Report ===");
    const stats = this.getStats();
    for (const stat of stats) {
      const indent = "  ".repeat(stat.depth);
      const prefix = stat.depth > 0 ? "- " : "";
      const label = (indent + prefix + stat.shortLabel).padEnd(30);
      if (stat.msPerFrame > 0) {
        console.log(
          `${label} calls/frame: ${stat.callsPerFrame.toFixed(1).padStart(6)}  ` +
            `ms/frame: ${stat.msPerFrame.toFixed(2).padStart(7)}  ` +
            `max: ${stat.maxMs.toFixed(2).padStart(7)}ms`,
        );
      } else {
        console.log(
          `${label} calls/frame: ${stat.callsPerFrame.toFixed(1).padStart(6)}  (count only)`,
        );
      }
    }
    console.log("========================");
  }

  /** Clear all stats */
  reset(): void {
    this.entries.clear();
    this.pathCache.clear();
    this.stack = [];
  }

  /** Enable/disable profiling (disabled = no overhead) */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Check if profiling is enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get all stats sorted hierarchically.
   * Optimized to O(n log n) by building parent-child map in a single pass.
   * @param maxChildrenPerParent If specified, limits the number of children shown per parent
   */
  getStats(maxChildrenPerParent?: number): ProfileStats[] {
    // Build parent-child map in a single pass (O(n))
    const childrenMap = new Map<string, ProfileStats[]>();
    const msLookup = new Map<string, number>();

    for (const [label, entry] of this.entries) {
      const segments = label.split(this.separator);
      const stat: ProfileStats = {
        label,
        shortLabel: segments[segments.length - 1],
        depth: segments.length - 1,
        callsPerFrame: entry.smoothedCallsPerFrame,
        msPerFrame: entry.smoothedMsPerFrame,
        maxMs: entry.maxMs,
      };
      msLookup.set(label, entry.smoothedMsPerFrame);

      // Determine parent path and register this stat as a child
      const parentPath =
        segments.length > 1 ? segments.slice(0, -1).join(this.separator) : "";
      let children = childrenMap.get(parentPath);
      if (!children) {
        children = [];
        childrenMap.set(parentPath, children);
      }
      children.push(stat);
    }

    // Recursively build sorted list (O(n log n) total for sorting)
    const buildSortedList = (parentPath: string): ProfileStats[] => {
      const children = childrenMap.get(parentPath);
      if (!children || children.length === 0) return [];

      const parentMs = msLookup.get(parentPath) ?? 0;

      // Sort children by ms descending
      children.sort((a, b) => {
        if (parentMs > 0) {
          return b.msPerFrame / parentMs - a.msPerFrame / parentMs;
        }
        return b.msPerFrame - a.msPerFrame;
      });

      // Limit children if needed
      const limited =
        maxChildrenPerParent !== undefined
          ? children.slice(0, maxChildrenPerParent)
          : children;

      const result: ProfileStats[] = [];
      for (const child of limited) {
        result.push(child);
        result.push(...buildSortedList(child.label));
      }
      return result;
    };

    return buildSortedList("");
  }

  /** Get top N stats by total time (cached within frame) */
  getTopStats(n: number, maxChildrenPerParent?: number): ProfileStats[] {
    // Check cache
    if (
      this.cachedStats &&
      this.cachedStatsParams?.maxChildren === maxChildrenPerParent
    ) {
      return this.cachedStats.slice(0, n);
    }

    // Compute and cache
    const stats = this.getStats(maxChildrenPerParent);
    this.cachedStats = stats;
    this.cachedStatsParams = { maxChildren: maxChildrenPerParent };
    return stats.slice(0, n);
  }

  private getOrCreate(label: string): ProfileEntry {
    let entry = this.entries.get(label);
    if (!entry) {
      entry = {
        frameCalls: 0,
        frameMs: 0,
        smoothedCallsPerFrame: 0,
        smoothedMsPerFrame: 0,
        maxMs: 0,
      };
      this.entries.set(label, entry);
    }
    return entry;
  }
}

export const profiler = new Profiler();

/**
 * Method decorator for easy profiling.
 *
 * Usage:
 *   class MyClass {
 *     @profile
 *     myMethod() { ... }
 *   }
 *
 * This will automatically profile as "MyClass.myMethod"
 */
export function profile<T extends (...args: any[]) => any>(
  target: T,
  context: ClassMethodDecoratorContext,
): T {
  const methodName = String(context.name);

  return function (this: any, ...args: Parameters<T>): ReturnType<T> {
    const className = this.constructor.name;
    return profiler.measure(`${className}.${methodName}`, () => {
      return target.call(this, ...args);
    });
  } as T;
}
