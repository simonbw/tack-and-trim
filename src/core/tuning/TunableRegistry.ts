/**
 * Registry for runtime-tunable values.
 *
 * In development builds, the parcel-transformer-tunables plugin scans for
 * `//#tunable` comments above `let` declarations and injects registration
 * calls that wire each variable to this registry via a setter callback.
 *
 * Usage in game code:
 *
 *   //#tunable { min: 0.1, max: 5 }
 *   let ZOOM_SPEED: number = 0.75;
 *
 * The variable remains a plain `let` — zero overhead on reads.
 * The TuningPanel UI reads from this registry to show sliders.
 */

export interface TunableOptions {
  min?: number;
  max?: number;
  step?: number;
}

export interface TunableEntry {
  /** Full path, e.g. "CameraController/ZOOM_SPEED" */
  path: string;
  /** Group name, e.g. "CameraController" */
  group: string;
  /** Variable name, e.g. "ZOOM_SPEED" */
  name: string;
  /** The initial value from the source code */
  defaultValue: number;
  /** The current runtime value */
  value: number;
  /** Slider constraints */
  options: TunableOptions;
  /** Callback that mutates the actual variable in its declaring scope */
  setter: (v: number) => void;
}

class TunableRegistry {
  private entries = new Map<string, TunableEntry>();
  private listeners = new Set<() => void>();

  /**
   * Register a tunable value. Called by transformer-generated code.
   */
  register(
    path: string,
    defaultValue: number,
    options: TunableOptions,
    setter: (v: number) => void,
  ): void {
    const lastSlash = path.lastIndexOf("/");
    const group = lastSlash >= 0 ? path.substring(0, lastSlash) : "General";
    const name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

    // Hot reload: if already registered, update the setter but keep current value
    const existing = this.entries.get(path);
    if (existing) {
      existing.setter = setter;
      setter(existing.value);
      return;
    }

    this.entries.set(path, {
      path,
      group,
      name,
      defaultValue,
      value: defaultValue,
      options,
      setter,
    });
    this.notify();
  }

  /** Update a tunable's value and call its setter. */
  set(path: string, value: number): void {
    const entry = this.entries.get(path);
    if (entry) {
      entry.value = value;
      entry.setter(value);
      this.notify();
    }
  }

  /** Reset one or all tunables to their default values. */
  reset(path?: string): void {
    if (path) {
      const entry = this.entries.get(path);
      if (entry) {
        entry.value = entry.defaultValue;
        entry.setter(entry.defaultValue);
        this.notify();
      }
    } else {
      for (const entry of this.entries.values()) {
        entry.value = entry.defaultValue;
        entry.setter(entry.defaultValue);
      }
      this.notify();
    }
  }

  /** Reset all tunables in a specific group. */
  resetGroup(group: string): void {
    for (const entry of this.entries.values()) {
      if (entry.group === group) {
        entry.value = entry.defaultValue;
        entry.setter(entry.defaultValue);
      }
    }
    this.notify();
  }

  /** Get all entries grouped by their group name. */
  getGroups(): Map<string, TunableEntry[]> {
    const groups = new Map<string, TunableEntry[]>();
    for (const entry of this.entries.values()) {
      let group = groups.get(entry.group);
      if (!group) {
        group = [];
        groups.set(entry.group, group);
      }
      group.push(entry);
    }
    return groups;
  }

  /** Whether any tunables have been registered. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const tunableRegistry = new TunableRegistry();

// Expose globally for transformer-generated code (avoids import path issues)
declare global {
  // eslint-disable-next-line no-var
  var __tunableRegistry: TunableRegistry | undefined;
}
globalThis.__tunableRegistry = tunableRegistry;
