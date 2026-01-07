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
import { Hull } from "./Hull";

const KEEL_VERTICES = [V(-15, 0), V(15, 0)];
const KEEL_LIFT_AND_DRAG = 1.5; // Reduced from 10 to compensate for foil's ~6x higher coefficients

export class Keel extends BaseEntity {
  private keelSprite: GameSprite & Graphics;

  constructor(private hull: Hull) {
    super();

    this.keelSprite = createGraphics("underhull");
    this.keelSprite
      .poly(KEEL_VERTICES, false)
      .stroke({ color: 0x665522, width: 3 });

    this.sprite = this.keelSprite;
  }

  onTick() {
    const lift = foilLift(KEEL_LIFT_AND_DRAG);
    const drag = foilDrag(KEEL_LIFT_AND_DRAG);

    // Get water velocity function
    const water = this.game?.entities.getById("waterInfo") as WaterInfo | undefined;
    const getWaterVelocity = (point: V2d): V2d =>
      water?.getStateAtPoint(point).velocity ?? V(0, 0);

    // Apply keel forces to hull (both directions for symmetry)
    for (const [start, end] of pairs(KEEL_VERTICES)) {
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
