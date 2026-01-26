/**
 * Wave Energy debug mode.
 *
 * Shows per-pixel shadow attenuation heatmap with wave component cycling.
 */

import type { DebugRenderMode, DebugRenderContext } from "../DebugRenderMode";
import { WAVE_COMPONENTS } from "../../world-data/water/WaterConstants";
import { InfluenceFieldManager } from "../../world-data/influence/InfluenceFieldManager";

export class WaveEnergyDebugMode implements DebugRenderMode {
  id = "waveEnergy";
  name = "Wave Energy";

  private waveComponentIndex = 0;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}

  render(_ctx: DebugRenderContext): void {
    // TODO: This debug mode needs to be updated for the new texture-based shadow system
    // The old implementation used shader-based rendering with shadow storage buffers.
    // This needs to be rewritten to use the new shadow texture approach.
    return;
  }

  onKeyDown(
    _ctx: DebugRenderContext,
    key: string,
    _event: KeyboardEvent,
  ): boolean {
    if (key === "BracketLeft") {
      // [ key - previous wave
      this.waveComponentIndex =
        (this.waveComponentIndex - 1 + WAVE_COMPONENTS.length) %
        WAVE_COMPONENTS.length;
      return true;
    } else if (key === "BracketRight") {
      // ] key - next wave
      this.waveComponentIndex =
        (this.waveComponentIndex + 1) % WAVE_COMPONENTS.length;
      return true;
    }
    return false;
  }

  getHudInfo(_ctx: DebugRenderContext): string | null {
    const wavelength = WAVE_COMPONENTS[this.waveComponentIndex][1];
    return `Wave ${this.waveComponentIndex}: λ=${wavelength}ft`;
  }

  getCursorInfo(ctx: DebugRenderContext): string | null {
    if (!ctx.cursorWorldPos) return null;

    const manager = InfluenceFieldManager.maybeFromGame(ctx.game);
    if (!manager || !manager.isInitialized()) return null;

    const depthGrid = manager.getDepthGrid();
    const config = manager.getDepthGridConfig();
    if (!depthGrid || !config) return null;

    const { x, y } = ctx.cursorWorldPos;
    const depth = this.sampleDepth(depthGrid, config, x, y);

    // Show position and whether in water/land
    const posStr = `(${x.toFixed(0)}, ${y.toFixed(0)})`;
    if (depth > 1) {
      return `${posStr}\nOn land`;
    } else {
      return `${posStr}\nDepth: ${(-depth).toFixed(1)}ft`;
    }
  }

  private sampleDepth(
    depthGrid: Float32Array,
    config: {
      originX: number;
      originY: number;
      cellSize: number;
      cellsX: number;
      cellsY: number;
    },
    worldX: number,
    worldY: number,
  ): number {
    const { originX, originY, cellSize, cellsX, cellsY } = config;

    const gx = (worldX - originX) / cellSize - 0.5;
    const gy = (worldY - originY) / cellSize - 0.5;

    const x0 = Math.max(0, Math.min(cellsX - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(cellsY - 2, Math.floor(gy)));
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const fx = Math.max(0, Math.min(1, gx - x0));
    const fy = Math.max(0, Math.min(1, gy - y0));

    const v00 = depthGrid[y0 * cellsX + x0];
    const v10 = depthGrid[y0 * cellsX + x1];
    const v01 = depthGrid[y1 * cellsX + x0];
    const v11 = depthGrid[y1 * cellsX + x1];

    const v0 = v00 * (1 - fx) + v10 * fx;
    const v1 = v01 * (1 - fx) + v11 * fx;
    return v0 * (1 - fy) + v1 * fy;
  }
}
