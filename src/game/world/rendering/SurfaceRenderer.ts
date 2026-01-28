import { BaseEntity } from "../../../core/entity/BaseEntity";

/**
 * Renders the water/terrain surface using virtual texture data.
 * Stub implementation - does nothing until real system is implemented.
 */
export class SurfaceRenderer extends BaseEntity {
  tickLayer = "water" as const;

  constructor() {
    super();
    this.id = "surface-renderer";
  }
}
