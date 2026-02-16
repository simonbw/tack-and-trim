/**
 * Runtime tuning panel UI.
 *
 * Renders a floating panel with sliders for all registered tunable values.
 * Toggle visibility with the backtick (`) key.
 */

import type { GameEventMap } from "../entity/Entity";
import { on } from "../entity/handler";
import { ReactEntity } from "../ReactEntity";
import { tunableRegistry, TunableEntry } from "./TunableRegistry";
import "./TuningPanel.css";

export class TuningPanel extends ReactEntity {
  id = "tuningPanel";
  persistenceLevel = 100;
  pausable = false;

  private visible = false;
  private collapsedGroups = new Set<string>();

  constructor() {
    super(() => this.renderPanel(), true);
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]) {
    if (key === "Backquote") {
      this.visible = !this.visible;
    }
  }

  private renderPanel() {
    if (!this.visible) {
      return <div class="tuning-panel--hidden" />;
    }

    const groups = tunableRegistry.getGroups();

    if (tunableRegistry.isEmpty) {
      return (
        <div class="tuning-panel">
          <div class="tuning-panel__header">
            <span class="tuning-panel__title">Tuning</span>
          </div>
          <div class="tuning-panel__empty">
            No tunable values registered.
            <br />
            Add <code>//#tunable</code> above a <code>let</code> declaration.
          </div>
        </div>
      );
    }

    return (
      <div class="tuning-panel">
        <div class="tuning-panel__header">
          <span class="tuning-panel__title">Tuning</span>
          <button
            class="tuning-panel__reset-all"
            onClick={() => tunableRegistry.reset()}
            title="Reset all values to defaults"
          >
            Reset All
          </button>
        </div>

        {Array.from(groups.entries()).map(([groupName, entries]) =>
          this.renderGroup(groupName, entries),
        )}
      </div>
    );
  }

  private renderGroup(groupName: string, entries: TunableEntry[]) {
    const collapsed = this.collapsedGroups.has(groupName);
    const hasModified = entries.some((e) => e.value !== e.defaultValue);

    return (
      <div class="tuning-group" key={groupName}>
        <div
          class="tuning-group__header"
          onClick={() => {
            if (collapsed) {
              this.collapsedGroups.delete(groupName);
            } else {
              this.collapsedGroups.add(groupName);
            }
          }}
        >
          <span
            class={`tuning-group__chevron ${collapsed ? "" : "tuning-group__chevron--open"}`}
          >
            {"\u25B6"}
          </span>
          <span class="tuning-group__label">{groupName}</span>
          {hasModified && (
            <button
              class="tuning-group__reset"
              onClick={(e: Event) => {
                e.stopPropagation();
                tunableRegistry.resetGroup(groupName);
              }}
              title="Reset group"
            >
              reset
            </button>
          )}
        </div>

        {!collapsed && (
          <div class="tuning-group__entries">
            {entries.map((entry) => this.renderEntry(entry))}
          </div>
        )}
      </div>
    );
  }

  private renderEntry(entry: TunableEntry) {
    const { min, max, step } = resolveSliderParams(entry);
    const isModified = entry.value !== entry.defaultValue;

    return (
      <div class="tuning-entry" key={entry.path}>
        <div class="tuning-entry__top-row">
          <span class="tuning-entry__name">{entry.name}</span>
          <input
            class={`tuning-entry__value-input ${isModified ? "tuning-entry__value-input--modified" : ""}`}
            type="number"
            value={formatValue(entry.value)}
            step={step}
            onInput={(e: Event) => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              if (!isNaN(v)) {
                tunableRegistry.set(entry.path, v);
              }
            }}
          />
          <button
            class={`tuning-entry__reset ${isModified ? "tuning-entry__reset--visible" : ""}`}
            onClick={() => tunableRegistry.reset(entry.path)}
            title={`Reset to ${entry.defaultValue}`}
          >
            {"\u21BA"}
          </button>
        </div>
        <div class="tuning-entry__slider-row">
          <input
            class="tuning-entry__slider"
            type="range"
            min={min}
            max={max}
            step="any"
            value={entry.value}
            onInput={(e: Event) => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              tunableRegistry.set(entry.path, v);
            }}
          />
        </div>
      </div>
    );
  }
}

/**
 * Figure out sensible slider min/max/step from the entry options and default value.
 */
function resolveSliderParams(entry: TunableEntry): {
  min: number;
  max: number;
  step: number;
} {
  const { defaultValue, options } = entry;

  // Use explicit bounds if provided, otherwise derive from default value
  let min = options.min ?? 0;
  let max = options.max ?? defaultValue * 3;

  // If the default is 0 and no max was given, pick a reasonable range
  if (defaultValue === 0 && options.max == null) {
    max = 1;
  }

  // Ensure min < max
  if (min >= max) {
    max = min + 1;
  }

  const step = options.step ?? deriveStep(min, max);

  return { min, max, step };
}

/** Derive a reasonable step size from the range. */
function deriveStep(min: number, max: number): number {
  const range = max - min;
  if (range > 100) return 1;
  if (range > 10) return 0.1;
  if (range > 1) return 0.01;
  return 0.001;
}

/** Format a number for display: trim trailing zeros, keep it readable. */
function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toString();
  // Show enough precision to be useful
  const s = v.toPrecision(4);
  // Strip trailing zeros after decimal point
  return parseFloat(s).toString();
}
