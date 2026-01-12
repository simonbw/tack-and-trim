import BaseEntity from "../../core/entity/BaseEntity";
import { pairs } from "../../core/util/FunctionalUtils";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForces,
  foilDrag,
  foilLift,
  KEEL_CHORD,
} from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { KeelConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Keel extends BaseEntity {
  layer = "underhull" as const;

  private vertices: V2d[];
  private color: number;

  constructor(
    private hull: Hull,
    config: KeelConfig,
  ) {
    super();

    this.vertices = config.vertices;
    this.color = config.color;
  }

  onTick() {
    // Use proper foil physics with real chord dimension
    const lift = foilLift(KEEL_CHORD);
    const drag = foilDrag(KEEL_CHORD);

    // Get water velocity function
    const water = WaterInfo.fromGame(this.game!);
    const getWaterVelocity = (point: V2d): V2d =>
      water.getStateAtPoint(point).velocity;

    // Apply keel forces to hull (both directions for symmetry)
    for (const [start, end] of pairs(this.vertices)) {
      applyFluidForces(
        this.hull.body,
        start,
        end,
        lift,
        drag,
        getWaterVelocity,
      );
      applyFluidForces(
        this.hull.body,
        end,
        start,
        lift,
        drag,
        getWaterVelocity,
      );
    }
  }

  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [x, y] = this.hull.body.position;

    draw.at({ pos: V(x, y), angle: this.hull.body.angle }, () => {
      // Draw keel as a polyline (open path)
      const path = draw.path();
      const first = this.vertices[0];
      path.moveTo(first.x, first.y);
      for (let i = 1; i < this.vertices.length; i++) {
        const v = this.vertices[i];
        path.lineTo(v.x, v.y);
      }
      path.stroke(this.color, 1, 1.0);
    });
  }
}
