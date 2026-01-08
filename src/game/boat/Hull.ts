import BaseEntity from "../../core/entity/BaseEntity";
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
      }),
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
      getWaterVelocity,
    );
  }

  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [x, y] = this.body.position;

    draw.at({ pos: V(x, y), angle: this.body.angle }, () => {
      // Draw hull polygon
      draw.polygon(this.vertices, { color: this.fillColor });

      // Draw stroke (outline) by drawing lines between vertices
      for (let i = 0; i < this.vertices.length; i++) {
        const v1 = this.vertices[i];
        const v2 = this.vertices[(i + 1) % this.vertices.length];
        draw.screenLine(v1.x, v1.y, v2.x, v2.y, {
          color: this.strokeColor,
          width: 1,
        });
      }
    });
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }
}
