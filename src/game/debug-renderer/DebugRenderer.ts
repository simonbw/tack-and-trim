/**
 * Unified Debug Renderer entity.
 *
 * Consolidates separate debug visualizations into a single entity with
 * consistent keyboard controls:
 * - Tab: Cycle forward through modes (including "Off")
 * - Shift+Tab: Cycle backward through modes
 * - [/]: Sub-mode cycling (delegated to active mode)
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { V2d } from "../../core/Vector";
import type { DebugRenderMode, DebugRenderContext } from "./DebugRenderMode";
import { DebugShaderManager } from "./DebugShaderManager";
import { DebugHUD } from "./DebugHUD";
import { TerrainHeightsDebugMode } from "./modes/TerrainHeightsDebugMode";
import { DepthGridDebugMode } from "./modes/DepthGridDebugMode";
import { ShadowZonesDebugMode } from "./modes/ShadowZonesDebugMode";
import { WaveEnergyDebugMode } from "./modes/WaveEnergyDebugMode";
import { WindFieldDebugMode } from "./modes/WindFieldDebugMode";

export class DebugRenderer extends BaseEntity {
  id = "debugRenderer";
  layer = "windViz" as const;

  private modes: DebugRenderMode[] = [];
  private activeModeIndex = -1; // -1 = off
  private shaderManager: DebugShaderManager;
  private hud: DebugHUD | null = null;
  private initialized = false;

  constructor() {
    super();
    this.shaderManager = new DebugShaderManager();
  }

  @on("add")
  async onAdd(): Promise<void> {
    // Initialize shader manager
    await this.shaderManager.init();

    // Create all modes
    this.modes = [
      new TerrainHeightsDebugMode(),
      new DepthGridDebugMode(),
      new ShadowZonesDebugMode(),
      new WaveEnergyDebugMode(),
      new WindFieldDebugMode(),
    ];

    // Create HUD
    this.hud = this.game.addEntity(new DebugHUD());

    this.initialized = true;
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]): void {
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

    // Delegate other keys to active mode
    if (this.activeModeIndex >= 0) {
      const mode = this.modes[this.activeModeIndex];
      const ctx = this.createContext(null!, this.getCursorWorldPos());
      mode.onKeyDown?.(ctx, key, event);
      // Update HUD after key handling (submode may have changed)
      this.updateHUD();
    }
  }

  private cycleMode(direction: 1 | -1): void {
    const ctx = this.createContext(null!, null);

    // Deactivate current mode
    if (this.activeModeIndex >= 0) {
      this.modes[this.activeModeIndex].onDeactivate?.(ctx);
    }

    // Cycle: -1 -> 0 -> 1 -> ... -> n-1 -> -1
    const total = this.modes.length + 1; // +1 for "off" state
    this.activeModeIndex =
      ((this.activeModeIndex + 1 + direction + total) % total) - 1;

    // Activate new mode
    if (this.activeModeIndex >= 0) {
      this.modes[this.activeModeIndex].onActivate?.(ctx);
    }

    // Update HUD
    this.updateHUD();
  }

  private getCursorWorldPos(): V2d | null {
    const io = this.game.io;
    if (!io.mousePosition) return null;
    return this.game.camera.toWorld(io.mousePosition);
  }

  private updateHUD(): void {
    if (!this.hud) return;

    const cursorWorldPos = this.getCursorWorldPos();
    const onCycleMode = (direction: 1 | -1) => this.cycleMode(direction);

    if (this.activeModeIndex < 0) {
      this.hud.setState({
        modeName: null,
        subModeInfo: null,
        cursorInfo: null,
        cursorWorldPos: null,
        onCycleMode,
      });
    } else {
      const mode = this.modes[this.activeModeIndex];
      const ctx = this.createContext(null!, cursorWorldPos);
      this.hud.setState({
        modeName: mode.name,
        subModeInfo: mode.getHudInfo?.(ctx) ?? null,
        cursorInfo: mode.getCursorInfo?.(ctx) ?? null,
        cursorWorldPos: cursorWorldPos
          ? { x: cursorWorldPos.x, y: cursorWorldPos.y }
          : null,
        onCycleMode,
      });
    }
  }

  private createContext(
    draw: Draw,
    cursorWorldPos: V2d | null,
  ): DebugRenderContext {
    const camera = this.game.camera;
    const worldViewport = camera.getWorldViewport();

    return {
      game: this.game,
      draw,
      viewport: {
        left: worldViewport.left,
        top: worldViewport.top,
        width: worldViewport.width,
        height: worldViewport.height,
      },
      cursorWorldPos,
    };
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    if (!this.initialized || this.activeModeIndex < 0) {
      return;
    }

    const cursorWorldPos = this.getCursorWorldPos();
    const ctx = this.createContext(draw, cursorWorldPos);
    const mode = this.modes[this.activeModeIndex];

    // Render the active mode
    mode.render(ctx);

    // Update HUD with current cursor info
    this.updateHUD();
  }

  @on("destroy")
  onDestroy(): void {
    // Deactivate current mode
    if (this.activeModeIndex >= 0 && this.initialized) {
      const ctx = this.createContext(null!, null);
      this.modes[this.activeModeIndex].onDeactivate?.(ctx);
    }

    // Destroy modes
    for (const mode of this.modes) {
      mode.destroy?.();
    }

    // Destroy shader manager
    this.shaderManager.destroy();

    // Remove HUD
    if (this.hud) {
      this.game.removeEntity(this.hud);
      this.hud = null;
    }

    this.modes = [];
    this.initialized = false;
  }
}
