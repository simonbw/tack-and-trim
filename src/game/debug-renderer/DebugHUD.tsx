/**
 * Debug HUD overlay showing current mode and keyboard controls.
 */

import type { VNode } from "preact";
import { ReactEntity } from "../../core/ReactEntity";
import "./DebugHUD.css";

export interface DebugHUDState {
  modeName: string | null; // null = off
  subModeInfo: string | null;
  cursorInfo: string | null;
  cursorWorldPos: { x: number; y: number } | null;
  onCycleMode: (direction: 1 | -1) => void;
}

/**
 * Debug HUD React entity.
 * Shows current debug mode and keyboard controls in a corner overlay.
 */
export class DebugHUD extends ReactEntity {
  private state: DebugHUDState = {
    modeName: null,
    subModeInfo: null,
    cursorInfo: null,
    cursorWorldPos: null,
    onCycleMode: () => {},
  };

  constructor() {
    super(() => this.renderContent(), false); // autoRender = false
  }

  /**
   * Update the HUD state and re-render.
   */
  setState(state: DebugHUDState): void {
    this.state = state;
    this.reactRender();
  }

  private renderContent(): VNode {
    const { modeName, subModeInfo, cursorInfo, cursorWorldPos, onCycleMode } =
      this.state;

    // Don't render anything if mode is off
    if (!modeName) {
      return <div className="debug-hud debug-hud--hidden" />;
    }

    // Format world coordinates if available
    const coordsLine = cursorWorldPos
      ? `(${cursorWorldPos.x.toFixed(1)}, ${cursorWorldPos.y.toFixed(1)})`
      : null;

    return (
      <div className="debug-hud">
        <div className="debug-hud__header">
          <button
            className="debug-hud__nav-btn"
            title="Previous mode (Shift+Tab)"
            onClick={() => onCycleMode(-1)}
          >
            ◀
          </button>
          <span className="debug-hud__mode">{modeName}</span>
          <button
            className="debug-hud__nav-btn"
            title="Next mode (Tab)"
            onClick={() => onCycleMode(1)}
          >
            ▶
          </button>
        </div>

        {subModeInfo && <div className="debug-hud__submode">{subModeInfo}</div>}

        {(coordsLine || cursorInfo) && (
          <div className="debug-hud__cursor">
            {coordsLine}
            {coordsLine && cursorInfo && "\n"}
            {cursorInfo}
          </div>
        )}
      </div>
    );
  }
}
