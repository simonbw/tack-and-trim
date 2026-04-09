import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { StaticBody } from "../../core/physics/body/StaticBody";
import { Box } from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import type { PortData } from "../../editor/io/LevelFileFormat";

// Dock dimensions in feet
const DOCK_LENGTH = 50; // ft — long enough for the largest boats
const DOCK_WIDTH = 5; // ft

// Cleat positions along dock length from shore end (0 = shore, 1 = tip)
const BOW_CLEAT_RATIO = 0.8; // near the tip (where bow ties)
const STERN_CLEAT_RATIO = 0.2; // near shore (where stern ties)

// Piling radius
const PILING_RADIUS = 0.8; // ft
const CLEAT_RADIUS = 0.4; // ft

// Colors
const DOCK_WOOD_COLOR = 0x8b6914;
const PILING_COLOR = 0x4a3728;
const CLEAT_COLOR = 0x333333;
const DOCK_OUTLINE_COLOR = 0x5a4410;

export class Port extends BaseEntity {
  tags = ["port"];
  layer = "boat" as const;
  body: StaticBody;

  private portData: PortData;

  // Local-space cleat positions (relative to dock center, before rotation)
  private bowCleatLocal: V2d;
  private sternCleatLocal: V2d;

  constructor(data: PortData) {
    super();

    this.portData = data;

    // Compute local cleat positions along the dock's length axis
    // The dock extends in the local +x direction from shore
    // Center of dock is at DOCK_LENGTH/2 along x
    const halfLength = DOCK_LENGTH / 2;
    this.bowCleatLocal = V(-halfLength + DOCK_LENGTH * BOW_CLEAT_RATIO, 0);
    this.sternCleatLocal = V(-halfLength + DOCK_LENGTH * STERN_CLEAT_RATIO, 0);

    // Create static body for collision
    this.body = new StaticBody({
      position: [data.position.x, data.position.y],
      angle: data.angle,
    });
    this.body.addShape(new Box({ width: DOCK_LENGTH, height: DOCK_WIDTH }));
  }

  getId(): string {
    return this.portData.id;
  }

  getName(): string {
    return this.portData.name;
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }

  /** Get bow cleat position in world space */
  getBowCleatWorld(): V2d {
    return this.body.toWorldFrame(this.bowCleatLocal);
  }

  /** Get stern cleat position in world space */
  getSternCleatWorld(): V2d {
    return this.body.toWorldFrame(this.sternCleatLocal);
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;
    const angle = this.body.angle;
    const halfW = DOCK_WIDTH / 2;
    const halfL = DOCK_LENGTH / 2;

    draw.at({ pos: V(x, y), angle }, () => {
      // Draw the dock planks (filled rectangle)
      draw.fillRect(-halfL, -halfW, DOCK_LENGTH, DOCK_WIDTH, {
        color: DOCK_WOOD_COLOR,
      });

      // Draw dock outline
      draw.strokeRect(-halfL, -halfW, DOCK_LENGTH, DOCK_WIDTH, {
        color: DOCK_OUTLINE_COLOR,
        width: 0.3,
      });

      // Draw pilings at the four corners
      const corners = [
        [-halfL, -halfW],
        [-halfL, halfW],
        [halfL, -halfW],
        [halfL, halfW],
      ];
      for (const [cx, cy] of corners) {
        draw.fillCircle(cx, cy, PILING_RADIUS, { color: PILING_COLOR });
      }

      // Draw cleats at the two cleat positions
      draw.fillCircle(
        this.bowCleatLocal.x,
        this.bowCleatLocal.y,
        CLEAT_RADIUS,
        { color: CLEAT_COLOR },
      );
      draw.fillCircle(
        this.sternCleatLocal.x,
        this.sternCleatLocal.y,
        CLEAT_RADIUS,
        { color: CLEAT_COLOR },
      );
    });
  }
}
