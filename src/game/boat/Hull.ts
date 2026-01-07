import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import DynamicBody from "../../core/physics/body/DynamicBody";
import Convex from "../../core/physics/shapes/Convex";
import { polygonArea } from "../../core/physics/utils/ShapeUtils";
import { V, V2d } from "../../core/Vector";
import { applySkinFriction } from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { HullConfig } from "./BoatConfig";

export class Hull extends BaseEntity {
  body: DynamicBody;
  private hullSprite: GameSprite & Graphics;
  private hullArea: number;
  private skinFrictionCoefficient: number;

  constructor(config: HullConfig) {
    super();

    this.hullArea = polygonArea(config.vertices);
    this.skinFrictionCoefficient = config.skinFrictionCoefficient;

    this.hullSprite = createGraphics("hull");
    this.hullSprite
      .roundShape(config.vertices, 3, true, 1) // Corner radius in ft
      .fill({ color: config.colors.fill })
      .stroke({ color: config.colors.stroke, width: 1, join: "round" });

    this.body = new DynamicBody({
      mass: config.mass,
    });

    this.body.addShape(
      new Convex({
        vertices: [...config.vertices],
      })
    );

    this.sprite = this.hullSprite;
  }

  onTick() {
    // Get water velocity function
    const water = this.game?.entities.getById("waterInfo") as WaterInfo | undefined;
    const getWaterVelocity = (point: V2d): V2d =>
      water?.getStateAtPoint(point).velocity ?? V(0, 0);

    applySkinFriction(this.body, this.hullArea, this.skinFrictionCoefficient, getWaterVelocity);
  }

  onRender() {
    const [x, y] = this.body.position;
    this.hullSprite.position.set(x, y);
    this.hullSprite.rotation = this.body.angle;
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }
}
