/**
 * User preference for which query backend to use (GPU compute vs CPU
 * worker pool). Persists to localStorage so the choice survives reloads.
 *
 * Only the "gpu" backend exists today; "cpu" is reserved for a future
 * Rust/WASM worker pool implementation.
 */

export type QueryBackendType = "gpu" | "cpu";

type Unsubscribe = () => void;

const KEY = "queryBackend";

function readInitial(): QueryBackendType {
  if (typeof localStorage === "undefined") return "gpu";
  const stored = localStorage.getItem(KEY);
  return stored === "cpu" ? "cpu" : "gpu";
}

let current: QueryBackendType = readInitial();

const subscribers = new Set<() => void>();

export function getQueryBackend(): QueryBackendType {
  return current;
}

export function setQueryBackend(backend: QueryBackendType): void {
  if (backend === current) return;
  current = backend;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, backend);
  }
  for (const cb of subscribers) cb();
}

export function onQueryBackendChange(cb: () => void): Unsubscribe {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
