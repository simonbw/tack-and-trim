import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { pairs } from "../../core/util/FunctionalUtils";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForces,
  foilDrag,
  foilLift,
} from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { KeelConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Keel extends BaseEntity {
  private keelSprite: GameSprite & Graphics;
  private vertices: V2d[];
  private liftAndDrag: number;

  constructor(
    private hull: Hull,
    config: KeelConfig
  ) {
    super();

    this.vertices = config.vertices;
    this.liftAndDrag = config.liftAndDrag;

    this.keelSprite = createGraphics("underhull");
    this.keelSprite
      .poly(config.vertices, false)
      .stroke({ color: config.color, width: 1 });

    this.sprite = this.keelSprite;
  }

  onTick() {
    const lift = foilLift(this.liftAndDrag);
    const drag = foilDrag(this.liftAndDrag);

    // Get water velocity function
    const water = this.game?.entities.getById("waterInfo") as WaterInfo | undefined;
    const getWaterVelocity = (point: V2d): V2d =>
      water?.getStateAtPoint(point).velocity ?? V(0, 0);

    // Apply keel forces to hull (both directions for symmetry)
    for (const [start, end] of pairs(this.vertices)) {
      applyFluidForces(this.hull.body, start, end, lift, drag, getWaterVelocity);
      applyFluidForces(this.hull.body, end, start, lift, drag, getWaterVelocity);
    }
  }

  onRender() {
    const [x, y] = this.hull.body.position;
    this.keelSprite.position.set(x, y);
    this.keelSprite.rotation = this.hull.body.angle;
  }
}
