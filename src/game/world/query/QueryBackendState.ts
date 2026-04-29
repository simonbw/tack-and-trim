/**
 * User preference for which query engine to use. Persists to localStorage so
 * the choice survives reloads.
 *
 * Three options:
 * - `"gpu"`: WebGPU compute pipeline.
 * - `"js"`: CPU worker pool dispatching to the TypeScript math ports.
 * - `"wasm"`: CPU worker pool dispatching to the Rust→WASM kernel.
 *
 * `"js"` and `"wasm"` both use the CPU worker pool and only differ in which
 * math kernel each worker calls.
 */

export type QueryEngine = "gpu" | "js" | "wasm";

/**
 * The CPU sub-engine type, kept as its own alias because the worker pool
 * protocol needs to distinguish JS vs WASM independently of GPU.
 */
export type CpuQueryEngine = "js" | "wasm";

type Unsubscribe = () => void;

const KEY_ENGINE = "queryEngine";
const KEY_LEGACY_BACKEND = "queryBackend";
const KEY_LEGACY_CPU_ENGINE = "queryCpuEngine";
const KEY_WORKER_COUNT = "queryWorkerCount";

function readInitialEngine(): QueryEngine {
  if (typeof localStorage === "undefined") return "wasm";
  const stored = localStorage.getItem(KEY_ENGINE);
  if (stored === "gpu" || stored === "js" || stored === "wasm") return stored;

  // Migrate from the legacy two-knob storage (queryBackend + queryCpuEngine).
  const legacyBackend = localStorage.getItem(KEY_LEGACY_BACKEND);
  const legacyCpuEngine = localStorage.getItem(KEY_LEGACY_CPU_ENGINE);
  let migrated: QueryEngine = "wasm";
  if (legacyBackend === "cpu") {
    migrated = legacyCpuEngine === "wasm" ? "wasm" : "js";
  } else if (legacyBackend === "gpu") {
    migrated = "gpu";
  }
  localStorage.setItem(KEY_ENGINE, migrated);
  localStorage.removeItem(KEY_LEGACY_BACKEND);
  localStorage.removeItem(KEY_LEGACY_CPU_ENGINE);
  return migrated;
}

let currentEngine: QueryEngine = readInitialEngine();

const subscribers = new Set<() => void>();

export function getQueryEngine(): QueryEngine {
  return currentEngine;
}

export function setQueryEngine(engine: QueryEngine): void {
  if (engine === currentEngine) return;
  currentEngine = engine;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY_ENGINE, engine);
  }
  for (const cb of subscribers) cb();
}

export function onQueryEngineChange(cb: () => void): Unsubscribe {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * Optional override for the CPU worker pool size. `null` means "use
 * the default heuristic" (`max(hardwareConcurrency - 4, 2)`).
 *
 * Mainly useful for benchmarks that want to sweep over different
 * worker counts without recompiling. Persists to localStorage but
 * isn't surfaced in the settings UI.
 */
export function getQueryWorkerCountOverride(): number | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem(KEY_WORKER_COUNT);
  if (stored == null) return null;
  const n = parseInt(stored, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setQueryWorkerCountOverride(n: number | null): void {
  if (typeof localStorage === "undefined") return;
  if (n == null) {
    localStorage.removeItem(KEY_WORKER_COUNT);
  } else {
    localStorage.setItem(KEY_WORKER_COUNT, String(n));
  }
}
