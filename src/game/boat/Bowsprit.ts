import BaseEntity from "../../core/entity/BaseEntity";
import { V2d } from "../../core/Vector";
import { Boat } from "./Boat";
import { BowspritConfig } from "./BoatConfig";

/** Bowsprit - a spar extending forward from the bow for jib attachment */
export class Bowsprit extends BaseEntity {
  layer = "main" as const;
  localPosition: V2d;
  size: V2d;
  boat: Boat;
  private color: number;

  constructor(boat: Boat, config: BowspritConfig) {
    super();

    this.localPosition = config.attachPoint;
    this.size = config.size;
    this.boat = boat;
    this.color = config.color;
  }

  onRender() {
    const renderer = this.game!.getRenderer();
    const hullBody = this.boat.hull.body;
    const worldPos = hullBody.toWorldFrame(this.localPosition);

    renderer.save();
    renderer.translate(worldPos[0], worldPos[1]);
    renderer.rotate(hullBody.angle);

    // Bowsprit visual - a spar extending forward from the bow
    renderer.drawRect(0, -this.size.y / 2, this.size.x, this.size.y, { color: this.color });

    renderer.restore();
  }
}
