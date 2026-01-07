import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { V2d } from "../../core/Vector";
import { Boat } from "./Boat";
import { BowspritConfig } from "./BoatConfig";

/** Bowsprit - a spar extending forward from the bow for jib attachment */
export class Bowsprit extends BaseEntity {
  sprite: GameSprite & Graphics;
  localPosition: V2d;
  size: V2d;
  boat: Boat;

  constructor(boat: Boat, config: BowspritConfig) {
    super();

    this.localPosition = config.attachPoint;
    this.size = config.size;
    this.boat = boat;

    // Bowsprit visual - a spar extending forward from the bow
    this.sprite = createGraphics("main")
      .rect(0, -config.size.y / 2, config.size.x, config.size.y)
      .fill({ color: config.color });
  }

  onRender() {
    const hullBody = this.boat.hull.body;
    this.sprite.position.copyFrom(hullBody.toWorldFrame(this.localPosition));
    this.sprite.rotation = hullBody.angle;
  }
}
