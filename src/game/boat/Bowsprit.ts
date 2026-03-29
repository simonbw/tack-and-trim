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
    const hull = this.boat.hull;
    const [hx, hy] = hull.body.position;
    const bowspritZ = this.boat.config.tilt.zHeights.bowsprit;

    // GPU-driven tilt projection: hull position + angle + tilt context.
    // Body-local coords with per-vertex z handle both parallax and depth.
    draw.at(
      {
        pos: V(hx, hy),
        angle: hull.body.angle,
        tilt: {
          roll: hull.body.roll,
          pitch: hull.body.pitch,
          zOffset: hull.body.z,
        },
      },
      () => {
        // Bowsprit visual - a spar extending forward from the bow
        // localPosition is already in hull-local coords
        draw.fillRect(
          this.localPosition.x,
          this.localPosition.y - this.size.y / 2,
          this.size.x,
          this.size.y,
          {
            color: this.color,
            z: bowspritZ,
          },
        );
      },
    );
  }
}
