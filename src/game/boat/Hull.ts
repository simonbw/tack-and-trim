import BaseEntity from "../../core/entity/BaseEntity";
import type { Draw } from "../../core/graphics/Draw";
import DynamicBody from "../../core/physics/body/DynamicBody";
import Convex from "../../core/physics/shapes/Convex";
import { polygonArea } from "../../core/physics/utils/ShapeUtils";
import { V, V2d } from "../../core/Vector";
import { applySkinFriction } from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { HullConfig } from "./BoatConfig";

export interface TillerConfig {
  position: V2d;
  getTillerAngle: () => number;
}

export class Hull extends BaseEntity {
  layer = "hull" as const;
  body: DynamicBody;
  private hullArea: number;
  private skinFrictionCoefficient: number;
  private vertices: V2d[];
  private fillColor: number;
  private strokeColor: number;
  private tillerConfig?: TillerConfig;

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
      draw.strokeSmoothPolygon(this.vertices, {
        color: 0x000000,
        alpha: 0.1,
        width: 1.5,
      });
      draw.fillSmoothPolygon(this.vertices, { color: this.fillColor });
      draw.strokeSmoothPolygon(this.vertices, {
        color: this.strokeColor,
        width: 0.25,
      });

      // Thwart (bench seat) - where helmsman sits, aft of centerboard
      const thwartColor = 0x886633;
      draw.fillRect(-3.5, -2.5, 0.5, 5, { color: thwartColor });
      draw.strokeRect(-3.5, -2.5, 0.5, 5, { color: 0x664422, width: 0.2 });

      // Centerboard trunk - center of cockpit
      const trunkColor = 0x665522;
      draw.fillRect(-1, -0.2, 2, 0.4, { color: trunkColor });
      draw.strokeRect(-1, -0.2, 2, 0.4, { color: 0x443311, width: 0.15 });

      // Tiller (rotates opposite to rudder)
      if (this.tillerConfig) {
        const tillerAngle = this.tillerConfig.getTillerAngle();
        const tillerPos = this.tillerConfig.position;
        const tillerLength = 3;
        const tillerWidth = 0.25;
        const tillerColor = 0x886633;

        draw.at({ pos: tillerPos, angle: tillerAngle }, () => {
          draw.fillRect(0, -tillerWidth / 2, tillerLength, tillerWidth, {
            color: tillerColor,
          });
          draw.strokeRect(0, -tillerWidth / 2, tillerLength, tillerWidth, {
            color: 0x664422,
            width: 0.1,
          });
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

  setTillerConfig(config: TillerConfig): void {
    this.tillerConfig = config;
  }
}
