interface ProfileEntry {
  calls: number;
  totalMs: number;
  maxMs: number;
  startTime?: number;
}

export interface ProfileStats {
  label: string;
  shortLabel: string;
  depth: number;
  callsPerSec: number;
  msPerSec: number;
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
  private resetTime = performance.now();

  // Stack tracking
  private stack: string[] = [];
  private pathCache = new Map<string, string>();
  private readonly separator = " > ";
  private readonly maxStackDepth = 10;

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
  count(label: string, amount: number = 1): void {
    if (!this.enabled) return;
    const entryKey = this.getEntryKey(label);
    const entry = this.getOrCreate(entryKey);
    entry.calls += amount;
  }

  /** Log a formatted report to console */
  report(): void {
    console.log("=== Profiler Report ===");
    const stats = this.getStats();
    for (const stat of stats) {
      const indent = "  ".repeat(stat.depth);
      const prefix = stat.depth > 0 ? "- " : "";
      const label = (indent + prefix + stat.shortLabel).padEnd(30);
      if (stat.msPerSec > 0) {
        console.log(
          `${label} calls/s: ${stat.callsPerSec.toFixed(0).padStart(6)}  ` +
            `ms/s: ${stat.msPerSec.toFixed(1).padStart(7)}  ` +
            `avg: ${stat.avgMs.toFixed(3).padStart(8)}ms  ` +
            `max: ${stat.maxMs.toFixed(2).padStart(7)}ms`,
        );
      } else {
        console.log(
          `${label} calls/s: ${stat.callsPerSec.toFixed(0).padStart(6)}  (count only)`,
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
    this.resetTime = performance.now();
  }

  /** Enable/disable profiling (disabled = no overhead) */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Check if profiling is enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Get all stats sorted hierarchically */
  getStats(): ProfileStats[] {
    const elapsedSec = Math.max(
      0.001,
      (performance.now() - this.resetTime) / 1000,
    );

    // Build flat stats list
    const allStats = [...this.entries.entries()].map(([label, entry]) => {
      const segments = label.split(this.separator);
      return {
        label,
        shortLabel: segments[segments.length - 1],
        depth: segments.length - 1,
        callsPerSec: entry.calls / elapsedSec,
        msPerSec: entry.totalMs / elapsedSec,
        avgMs: entry.calls > 0 ? entry.totalMs / entry.calls : 0,
        maxMs: entry.maxMs,
      };
    });

    // Find children of a given parent path
    const getChildren = (parentPath: string): ProfileStats[] => {
      const parentDepth = parentPath
        ? parentPath.split(this.separator).length
        : 0;
      return allStats.filter((s) => {
        if (s.depth !== parentDepth) return false;
        if (parentPath === "") return s.depth === 0;
        return (
          s.label.startsWith(parentPath + this.separator) &&
          s.label.split(this.separator).length === parentDepth + 1
        );
      });
    };

    // Recursively build sorted tree (depth-first, siblings sorted by % of parent desc)
    const buildSortedList = (parentPath: string): ProfileStats[] => {
      const parent = allStats.find((s) => s.label === parentPath);
      const parentMs = parent?.msPerSec ?? 0;

      // Sort children by percentage of parent (or by msPerSec if no parent)
      const children = getChildren(parentPath).sort((a, b) => {
        if (parentMs > 0) {
          return b.msPerSec / parentMs - a.msPerSec / parentMs;
        }
        return b.msPerSec - a.msPerSec;
      });

      const result: ProfileStats[] = [];
      for (const child of children) {
        result.push(child);
        result.push(...buildSortedList(child.label));
      }
      return result;
    };

    return buildSortedList("");
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
