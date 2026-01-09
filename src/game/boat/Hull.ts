import BaseEntity from "../../core/entity/BaseEntity";
import type { Draw } from "../../core/graphics/Draw";
import DynamicBody from "../../core/physics/body/DynamicBody";
import Convex from "../../core/physics/shapes/Convex";
import { polygonArea } from "../../core/physics/utils/ShapeUtils";
import { V, V2d } from "../../core/Vector";
import { applySkinFriction } from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { HullConfig } from "./BoatConfig";

export class Hull extends BaseEntity {
  layer = "hull" as const;
  body: DynamicBody;
  private hullArea: number;
  private skinFrictionCoefficient: number;
  private vertices: V2d[];
  private fillColor: number;
  private strokeColor: number;

  constructor(config: HullConfig) {
    super();

    this.hullArea = polygonArea(config.vertices);
    this.skinFrictionCoefficient = config.skinFrictionCoefficient;
    this.vertices = config.vertices;
    this.fillColor = config.colors.fill;
    this.strokeColor = config.colors.stroke;

    this.body = new DynamicBody({
      mass: config.mass,
    });

    this.body.addShape(
      new Convex({
        vertices: [...config.vertices],
      })
    );
  }

  onTick() {
    // Get water velocity function
    const water = this.game?.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    const getWaterVelocity = (point: V2d): V2d =>
      water?.getStateAtPoint(point).velocity ?? V(0, 0);

    applySkinFriction(
      this.body,
      this.hullArea,
      this.skinFrictionCoefficient,
      getWaterVelocity
    );
  }

  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;

    draw.at({ pos: V(x, y), angle: this.body.angle }, () => {
      draw.strokePolygon(this.vertices, {
        color: 0x000000,
        alpha: 0.1,
        width: 1.5,
      });
      draw.fillPolygon(this.vertices, { color: this.fillColor });
      draw.strokePolygon(this.vertices, {
        color: this.strokeColor,
        width: 0.5,
      });
    });
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }
}
