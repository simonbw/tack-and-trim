import { BaseEntity } from "../../core/entity/BaseEntity";
import { Boat } from "./Boat";
import { LifelinesConfig } from "./BoatConfig";

/** Lifelines, stanchions, bow pulpit, and stern pulpit.
 *  Rendering is handled by BoatRenderer. */
export class Lifelines extends BaseEntity {
  private boat: Boat;
  private config: LifelinesConfig;

  constructor(boat: Boat, config: LifelinesConfig) {
    super();
    this.boat = boat;
    this.config = config;
  }
}
