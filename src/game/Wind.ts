import BaseEntity from "../core/entity/BaseEntity";
import { V, V2d } from "../core/Vector";

const WIND_VELOCITY = V(100, 100);

export class Wind extends BaseEntity {
  id = "wind";

  getVelocity(): V2d {
    return V(WIND_VELOCITY);
  }

  getVelocityAtPoint(_point: [number, number]): V2d {
    // For now, constant wind everywhere
    // Later: could add spatial variation, gusts, etc.
    return this.getVelocity();
  }
}
