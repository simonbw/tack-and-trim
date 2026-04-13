import { BaseEntity } from "../../core/entity/BaseEntity";
import { V2d } from "../../core/Vector";
import { Boat } from "./Boat";
import { BowspritConfig } from "./BoatConfig";

/** Bowsprit - a spar extending forward from the bow for jib attachment */
export class Bowsprit extends BaseEntity {
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

  /** Visual color for the bowsprit. */
  getColor(): number {
    return this.color;
  }
}
