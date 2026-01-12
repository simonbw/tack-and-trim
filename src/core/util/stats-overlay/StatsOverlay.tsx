import React from "react";
import Entity, { GameEventMap } from "../../entity/Entity";
import { ReactEntity } from "../../ReactEntity";
import { profile } from "../Profiler";
import "./StatsOverlay.css";
import type { StatsPanel, StatsPanelContext } from "./StatsPanel";

const SMOOTHING = 0.95;
const RENDER_THROTTLE = 3; // Only re-render every N frames

/**
 * Stats overlay entity that displays debug/performance information.
 * Accepts an array of panels via constructor - each panel is self-contained
 * with its own rendering, data fetching, and keyboard handling.
 *
 * @example
 * ```typescript
 * import StatsOverlay, {
 *   createLeanPanel,
 *   createProfilerPanel,
 *   createGraphicsPanel
 * } from "../core/util/stats-overlay";
 *
 * game.addEntity(new StatsOverlay([
 *   createLeanPanel(),
 *   createProfilerPanel(),
 *   createGraphicsPanel(),
 * ]));
 * ```
 */
export default class StatsOverlay extends ReactEntity implements Entity {
  persistenceLevel = 100;

  private panels: StatsPanel[];
  private activePanelIndex: number = -1; // -1 = closed

  private averageDuration: number = 0;
  private lastUpdate = performance.now();
  private frameCounter = 0;

  constructor(panels: StatsPanel[]) {
    super(() => this.renderContent(), false); // autoRender = false for throttling
    this.panels = panels;
  }

  private renderContent(): React.ReactElement {
    if (this.activePanelIndex < 0) {
      return <></>;
    }

    const panel = this.panels[this.activePanelIndex];
    const ctx = this.getContext();

    return <div className="stats-overlay">{panel.render(ctx)}</div>;
  }

  private getContext(): StatsPanelContext {
    return {
      game: this.game!,
      fps: Math.ceil(1000 / this.averageDuration),
      fps2: this.game!.getScreenFps(),
    };
  }

  private cycleMode(direction: 1 | -1) {
    // -1 = closed, 0..n-1 = panel indices
    const total = this.panels.length + 1; // +1 for closed state
    this.activePanelIndex =
      ((this.activePanelIndex + 1 + direction + total) % total) - 1;
    // Immediately render to show the change (don't wait for throttle)
    this.reactRender();
  }

  onAdd() {
    super.onAdd();
    this.averageDuration = 1 / 60;
  }

  @profile
  onRender() {
    const now = performance.now();
    const duration = now - this.lastUpdate;
    this.averageDuration =
      SMOOTHING * this.averageDuration + (1.0 - SMOOTHING) * duration;
    this.lastUpdate = now;

    // Throttle React re-renders (20fps is plenty for stats display)
    this.frameCounter++;
    if (
      this.activePanelIndex >= 0 &&
      this.frameCounter % RENDER_THROTTLE === 0
    ) {
      this.reactRender();
    }
  }

  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Backquote") {
      this.cycleMode(event.shiftKey ? -1 : 1);
      return;
    }

    // Delegate to active panel
    if (this.activePanelIndex >= 0) {
      const panel = this.panels[this.activePanelIndex];
      panel.onKeyDown?.(this.getContext(), key, event);
    }
  }
}
