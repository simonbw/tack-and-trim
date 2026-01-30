/**
 * Unified Debug Renderer entity.
 *
 * Consolidates separate debug visualizations into a single entity with
 * consistent keyboard controls:
 * - Tab: Cycle forward through modes (including "Off")
 * - Shift+Tab: Cycle backward through modes
 * - [/]: Sub-mode cycling (delegated to active mode)
 */

import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { ReactEntity } from "../../core/ReactEntity";
import { DebugHUD } from "./DebugHUD";
import { DebugRenderMode } from "./modes/DebugRenderMode";
import { WindDebugRenderMode } from "./modes/WindDebugRenderMode";

export class DebugRenderer extends ReactEntity {
  id = "debugRenderer";

  private modeConstructors: Array<() => DebugRenderMode> = [
    () => new WindDebugRenderMode(),
  ];
  private activeModeIndex = -1; // -1 = off
  private currentMode: DebugRenderMode | null = null;
  private hud: DebugHUD | null = null;

  constructor() {
    super(() => this.renderHud(), true);
    this.hud = this.addChild(new DebugHUD());
  }

  renderHud() {
    const mouseWorldPos = this.game.camera.screenToWorld(
      this.game.io.mousePosition,
    );
    if (this.currentMode) {
      const modeName = this.currentMode.id;
      const modeContent = this.currentMode.getHudInfo();
      const cursorContent = this.currentMode.getCursorInfo();
      return (
        <div className="debug-hud">
          <div className="debug-hud__header">
            <button
              className="debug-hud__nav-btn"
              title="Previous mode (Shift+Tab)"
              onClick={() => this.cycleMode(-1)}
            >
              ◀
            </button>
            <span className="debug-hud__mode">{modeName}</span>
            <button
              className="debug-hud__nav-btn"
              title="Next mode (Tab)"
              onClick={() => this.cycleMode(1)}
            >
              ▶
            </button>
          </div>

          {modeContent && (
            <div className="debug-hud__submode">{modeContent}</div>
          )}

          <div className="debug-hud__cursor">
            {mouseWorldPos.toLocaleString([], { maximumFractionDigits: 1 })}
          </div>
        </div>
      );
    } else {
      return null;
    }
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        // Shift+Tab: Cycle backward
        this.cycleMode(-1);
      } else {
        // Tab: Cycle forward
        this.cycleMode(1);
      }
      return;
    }
  }

  private cycleMode(direction: 1 | -1): void {
    // Cycle: -1 -> 0 -> 1 -> ... -> n-1 -> -1
    const total = this.modeConstructors.length + 1; // +1 for "off" state
    const index = ((this.activeModeIndex + 1 + direction + total) % total) - 1;
    this.setActiveMode(index);
  }

  setActiveMode(index: number): void {
    if (index < -1 || index >= this.modeConstructors.length) {
      throw new Error("Invalid debug mode index: " + index);
    }
    this.activeModeIndex = index;

    if (this.currentMode) {
      this.currentMode.destroy();
      this.currentMode = null;
    }

    // Activate new mode
    if (this.activeModeIndex >= 0) {
      this.currentMode = this.addChild(
        this.modeConstructors[this.activeModeIndex](),
      );
      if (!this.hud) {
        this.hud = this.addChild(new DebugHUD());
      }
    } else {
      this.hud?.destroy();
      this.hud = null;
    }
  }
}
