/**
 * Tiny factory for user-facing settings that persist across reloads.
 *
 * Replaces the boilerplate get/set/subscribe/localStorage block we used
 * to copy-paste into every `*State.ts` module. Each setting becomes a
 * single `createPersistedState()` call; the file's exported helpers
 * (`getX`, `setX`, `onXChange`) become thin wrappers so consumers don't
 * have to change.
 *
 * Persistence is fire-and-forget: localStorage failures (quota, disabled
 * storage, server-side render) never crash the caller.
 *
 * Storage keys are namespaced under `tack-and-trim:setting:` so they
 * don't collide with save files (`tack-and-trim:save:*`) or with
 * unrelated localStorage keys. A one-time migration copies values from
 * the legacy bare keys (e.g. `"renderScale"`) the first time the
 * namespaced key is read missing.
 *
 * Subscribers fire synchronously after `set()` mutates the in-memory
 * value and writes to storage. They receive the new value as their
 * single argument (settings whose subscribers don't care about the
 * value can simply ignore it — TypeScript permits `() => void`).
 */

const NAMESPACE = "tack-and-trim:setting:";

type Subscriber<T> = (value: T) => void;
type Unsubscribe = () => void;

export interface PersistedState<T> {
  get(): T;
  set(value: T): void;
  subscribe(callback: Subscriber<T>): Unsubscribe;
}

export interface PersistedStateConfig<T> {
  /** Storage key (un-namespaced). The factory adds the namespace prefix. */
  key: string;
  /** Value to use if storage is empty, missing, or fails validation. */
  default: T;
  /**
   * Convert a value to a string for storage. Defaults to `String(value)`,
   * which is fine for primitives. Pass `JSON.stringify` for objects.
   */
  serialize?: (value: T) => string;
  /**
   * Parse a stored string back into a value. Defaults to identity
   * (assumes `T extends string`). Pair with `validate` to reject
   * malformed data.
   */
  deserialize?: (raw: string) => unknown;
  /**
   * Gate against corrupt or unexpected storage values. Return `null`
   * (or `undefined`) to fall back to `default`. If omitted, the
   * deserialized value is trusted as-is.
   */
  validate?: (candidate: unknown) => T | null | undefined;
}

function safeGetItem(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage may be unavailable (private mode, quota exceeded,
    // disabled by site settings). Persistence is best-effort.
  }
}

function safeRemoveItem(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as safeSetItem: best-effort.
  }
}

/**
 * One-time migration: if the namespaced key is empty but the legacy
 * bare key exists, copy the value over and delete the legacy key.
 * Returns the migrated raw value (or null) so the caller can avoid a
 * second read.
 */
function migrateLegacyKey(
  namespacedKey: string,
  legacyKey: string,
): string | null {
  const existing = safeGetItem(namespacedKey);
  if (existing !== null) return existing;
  const legacy = safeGetItem(legacyKey);
  if (legacy === null) return null;
  safeSetItem(namespacedKey, legacy);
  safeRemoveItem(legacyKey);
  return legacy;
}

export function createPersistedState<T>(
  config: PersistedStateConfig<T>,
): PersistedState<T> {
  const namespacedKey = NAMESPACE + config.key;
  const serialize = config.serialize ?? ((v: T) => String(v));
  const deserialize = config.deserialize ?? ((raw: string) => raw);
  const validate = config.validate;

  function readInitial(): T {
    const raw = migrateLegacyKey(namespacedKey, config.key);
    if (raw === null) return config.default;
    let parsed: unknown;
    try {
      parsed = deserialize(raw);
    } catch {
      return config.default;
    }
    if (validate) {
      const validated = validate(parsed);
      if (validated === null || validated === undefined) return config.default;
      return validated;
    }
    return parsed as T;
  }

  let current: T = readInitial();
  const subscribers = new Set<Subscriber<T>>();

  return {
    get(): T {
      return current;
    },
    set(value: T): void {
      if (Object.is(value, current)) return;
      current = value;
      safeSetItem(namespacedKey, serialize(value));
      for (const cb of subscribers) cb(value);
    },
    subscribe(callback: Subscriber<T>): Unsubscribe {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}
