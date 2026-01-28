import { BaseEntity } from "../../../core/entity/BaseEntity";

/**
 * Configuration for the surface renderer.
 */
export interface SurfaceRendererConfig {
  textureScale?: number;
  waterTextureScale?: number;
  terrainTextureScale?: number;
  wetnessTextureScale?: number;
}

/**
 * Renders the water/terrain surface using virtual texture data.
 * Stub implementation - does nothing until real system is implemented.
 */
export class SurfaceRenderer extends BaseEntity {
  tickLayer = "water" as const;
  private renderMode = 0;

  constructor(config?: SurfaceRendererConfig) {
    super();
    this.id = "surface-renderer";
    // TODO (Phase 2+): Use config for actual texture-based rendering
  }

  /**
   * Set the render mode (0 = normal, 1 = debug).
   * TODO (Phase 2+): Implement actual render mode switching.
   */
  setRenderMode(mode: number): void {
    this.renderMode = mode;
  }
}
