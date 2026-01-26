/**
 * Depth Grid debug mode.
 *
 * Shows terrain depth (land/water/shoreline) using GPU shader.
 */

import type { DebugRenderMode, DebugRenderContext } from "../DebugRenderMode";
import type { DebugShaderManager } from "../DebugShaderManager";
import { InfluenceFieldManager } from "../../world-data/influence/InfluenceFieldManager";

export class DepthGridDebugMode implements DebugRenderMode {
  id = "depthGrid";
  name = "Depth Grid";

  constructor(private shaderManager: DebugShaderManager) {}

  render(ctx: DebugRenderContext): void {
    if (!this.shaderManager.isInitialized()) return;

    const manager = InfluenceFieldManager.maybeFromGame(ctx.game);
    if (!manager || !manager.isInitialized()) return;

    const depthTexture = manager.getDepthTexture();
    const depthGridConfig = manager.getDepthGridConfig();
    if (!depthTexture || !depthGridConfig) return;

    // Update uniforms (mode 1 = depth)
    this.shaderManager.updateUniforms(ctx.viewport, depthGridConfig, 1, 0, 0);

    // Rebuild bind group if needed
    this.shaderManager.rebuildBindGroup(depthTexture, null, null, null, null);

    // Render
    const renderer = ctx.game.getRenderer();
    const renderPass = renderer.getCurrentRenderPass();
    if (renderPass) {
      this.shaderManager.render(renderPass);
    }
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

    if (depth > 1) {
      return `Land: ${depth.toFixed(1)}ft`;
    } else if (depth < -1) {
      return `Water: ${(-depth).toFixed(1)}ft deep`;
    } else {
      return `Shoreline: ${depth.toFixed(2)}ft`;
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
