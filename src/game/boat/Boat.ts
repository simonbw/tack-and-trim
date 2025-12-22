import BaseEntity from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { polarToVec } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Hull } from "./Hull";
import { Keel } from "./Keel";
import { Mainsheet } from "./Mainsheet";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";
import { WindIndicator } from "./WindIndicator";

const MAST_POSITION = V(5, 0);

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  mainsheet: Mainsheet;
  windIndicator: WindIndicator;

  constructor() {
    super();

    // Create hull first - everything attaches to it
    this.hull = new Hull();

    // Create parts that attach to hull
    this.keel = new Keel(this.hull);
    this.rudder = new Rudder(this.hull);
    this.rig = new Rig(this.hull, MAST_POSITION);

    // Create parts that need rig reference
    this.mainsheet = new Mainsheet(this.hull, this.rig);
    this.windIndicator = new WindIndicator(this.hull, this.rig);
  }

  onAdd() {
    // Add all children - they will be registered with the game
    this.addChild(this.hull);
    this.addChild(this.keel);
    this.addChild(this.rudder);
    this.addChild(this.rig);
    this.addChild(this.mainsheet);
    this.addChild(this.windIndicator);
  }

  onTick(dt: GameEventMap["tick"]) {
    // Handle input
    const [steer] = this.game!.io.getMovementVector();

    // Update rudder steering
    this.rudder.setSteer(steer, dt);
  }

  onKeyDown({ key }: GameEventMap["keyDown"]) {
    if (key === "Space") {
      this.hull.body.applyImpulse(polarToVec(this.hull.body.angle, 50));
    }
  }

  getPosition(): V2d {
    return this.hull.getPosition();
  }
}
