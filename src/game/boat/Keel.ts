import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { pairs } from "../../core/util/FunctionalUtils";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForces,
  foilDrag,
  foilLift,
  KEEL_CHORD,
} from "../fluid-dynamics";
import { WaterQuery } from "../world/query/WaterQuery";
import { KeelConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Keel extends BaseEntity {
  layer = "underhull" as const;

  private vertices: V2d[];
  private color: number;
  private waterQuery: WaterQuery;

  constructor(
    private hull: Hull,
    config: KeelConfig,
  ) {
    super();

    this.vertices = config.vertices;
    this.color = config.color;

    // Create water query for all keel vertices
    this.waterQuery = this.addChild(
      new WaterQuery(() =>
        this.vertices.map((v) => this.hull.body.toWorldFrame(v)),
      ),
    );
  }

  @on("tick")
  onTick() {
    // Use proper foil physics with real chord dimension
    const lift = foilLift(KEEL_CHORD);
    const drag = foilDrag(KEEL_CHORD);

    // Get water velocity from query results (or assume still water if no results yet)
    const results = this.waterQuery.results;
    const getWaterVelocity = (point: V2d): V2d => {
      // Find the closest query result for this point
      if (results.length === 0) return V(0, 0);

      // For simplicity, use the average water velocity across all keel points
      let totalVelocity = V(0, 0);
      for (const result of results) {
        totalVelocity.iadd(result.velocity);
      }
      return totalVelocity.idiv(results.length);
    };

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

  @on("render")
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
