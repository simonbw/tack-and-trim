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
import { WaterQuery } from "../world/water/WaterQuery";
import { KeelConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Keel extends BaseEntity {
  layer = "underhull" as const;

  private vertices: V2d[];
  private color: number;

  // Water query for keel vertices (transforms to world space for query)
  private waterQuery = this.addChild(
    new WaterQuery(() => this.getQueryPoints()),
  );

  // Cached water velocities indexed by world position key
  private velocityCache = new Map<string, V2d>();

  constructor(
    private hull: Hull,
    config: KeelConfig,
  ) {
    super();

    this.vertices = config.vertices;
    this.color = config.color;
  }

  /**
   * Get query points in world space for all keel vertices.
   */
  private getQueryPoints(): V2d[] {
    const points: V2d[] = [];
    for (const v of this.vertices) {
      points.push(this.hull.body.toWorldFrame(v));
    }
    return points;
  }

  @on("tick")
  onTick() {
    // Build velocity cache from query results
    this.velocityCache.clear();
    const queryPoints = this.getQueryPoints();
    for (let i = 0; i < this.waterQuery.results.length; i++) {
      const point = queryPoints[i];
      if (point) {
        const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
        this.velocityCache.set(key, this.waterQuery.results[i].velocity);
      }
    }

    // Use proper foil physics with real chord dimension
    const lift = foilLift(KEEL_CHORD);
    const drag = foilDrag(KEEL_CHORD);

    // Get water velocity from cache or default to zero
    const getWaterVelocity = (point: V2d): V2d => {
      const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      return this.velocityCache.get(key) ?? V(0, 0);
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
