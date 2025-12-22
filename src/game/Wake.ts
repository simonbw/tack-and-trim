import BaseEntity from "../core/entity/BaseEntity";
import { Boat } from "./Boat";

export class Wake extends BaseEntity {
  constructor(private boat: Boat) {
    super();
  }

  onRender() {
    const [x, y] = this.boat.getPosition();
    // Render the wake effect behind the boat
  }
}
