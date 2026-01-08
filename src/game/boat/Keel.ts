import BaseEntity from "../../core/entity/BaseEntity";
import { pairs } from "../../core/util/FunctionalUtils";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces, foilDrag, foilLift } from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { KeelConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Keel extends BaseEntity {
  layer = "underhull" as const;

  private vertices: V2d[];
  private liftAndDrag: number;
  private color: number;

  constructor(
    private hull: Hull,
    config: KeelConfig,
  ) {
    super();

    this.vertices = config.vertices;
    this.liftAndDrag = config.liftAndDrag;
    this.color = config.color;
  }

  onTick() {
    const lift = foilLift(this.liftAndDrag);
    const drag = foilDrag(this.liftAndDrag);

    // Get water velocity function
    const water = this.game?.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    const getWaterVelocity = (point: V2d): V2d =>
      water?.getStateAtPoint(point).velocity ?? V(0, 0);

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
