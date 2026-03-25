import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { V, V2d } from "../../core/Vector";
import { Boat } from "./Boat";
import { BowspritConfig } from "./BoatConfig";

/** Bowsprit - a spar extending forward from the bow for jib attachment */
export class Bowsprit extends BaseEntity {
  layer = "boat" as const;
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

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const hullBody = this.boat.hull.body;
    const worldPos = hullBody.toWorldFrame(this.localPosition);

    // Bowsprit parallax — slightly above waterline
    const bowspritZ = this.boat.config.tilt.zHeights.bowsprit;
    const offset = this.boat.hull.tiltTransform.worldOffset(bowspritZ);

    draw.at(
      {
        pos: V(worldPos[0] + offset.x, worldPos[1] + offset.y),
        angle: hullBody.angle,
      },
      () => {
        // Bowsprit visual - a spar extending forward from the bow
        draw.fillRect(0, -this.size.y / 2, this.size.x, this.size.y, {
          color: this.color,
          z: bowspritZ,
        });
      },
    );
  }
}
