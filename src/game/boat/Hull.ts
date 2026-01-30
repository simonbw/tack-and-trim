import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { Convex } from "../../core/physics/shapes/Convex";
import { polygonArea } from "../../core/physics/utils/ShapeUtils";
import { V, V2d } from "../../core/Vector";
import { applySkinFriction } from "../fluid-dynamics";
import { WaterQuery } from "../world/query/WaterQuery";
import { HullConfig } from "./BoatConfig";

/**
 * Find the stern (aftmost) port and starboard vertices from hull geometry.
 * Finds the two vertices with the minimum x values (furthest aft).
 */
export function findSternPoints(vertices: V2d[]): {
  port: V2d;
  starboard: V2d;
} {
  // Sort vertices by x (ascending) to find the aftmost points
  const sorted = [...vertices].sort((a, b) => a.x - b.x);

  // Take the two most aft vertices
  const v1 = sorted[0];
  const v2 = sorted[1];

  // Determine port (positive y) vs starboard (negative y)
  if (v1.y > v2.y) {
    return { port: v1, starboard: v2 };
  } else {
    return { port: v2, starboard: v1 };
  }
}

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
  private waterQuery: WaterQuery;

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

    // Create water query for hull center position
    this.waterQuery = this.addChild(new WaterQuery(() => [this.body.position]));
  }

  @on("tick")
  onTick() {
    // Get water velocity from query results (or assume still water if no results yet)
    const results = this.waterQuery.results;
    const waterVelocity = results.length > 0 ? results[0].velocity : V(0, 0);

    const getWaterVelocity = (_point: V2d): V2d => waterVelocity;

    applySkinFriction(
      this.body,
      this.hullArea,
      this.skinFrictionCoefficient,
      getWaterVelocity,
    );
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
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
