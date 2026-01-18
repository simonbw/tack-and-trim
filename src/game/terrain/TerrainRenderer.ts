/**
 * Terrain renderer entity.
 *
 * Renders land masses on the "land" layer, which appears beneath
 * the water layer. When water transparency is enabled, shallow
 * areas will show the sand/terrain through the water.
 */

import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { TerrainInfo } from "./TerrainInfo";

// Sand/beach color
const SAND_COLOR = 0xc2b280; // Sandy tan

/**
 * Renders terrain/land beneath the water.
 */
export class TerrainRenderer extends BaseEntity {
  id = "terrainRenderer";
  layer = "land" as const;

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const terrain = TerrainInfo.maybeFromGame(this.game!);
    if (!terrain) return;

    for (const landMass of terrain.getLandMasses()) {
      if (landMass.coastline.length < 3) continue;

      // Draw filled polygon with sandy color
      draw.fillPolygon(landMass.coastline, {
        color: SAND_COLOR,
      });
    }
  }
}
