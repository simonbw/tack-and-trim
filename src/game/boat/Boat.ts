import BaseEntity from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { polarToVec } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Hull } from "./Hull";
import { Keel } from "./Keel";
import { Mainsheet } from "./Mainsheet";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";

const MAST_POSITION = V(5, 0);

const ROW_DURATION = 0.6; // seconds per row
const ROW_FORCE = 200; // force per row

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  mainsheet: Mainsheet;

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
  }

  onAdd() {
    // Add all children - they will be registered with the game
    this.addChild(this.hull);
    this.addChild(this.keel);
    this.addChild(this.rudder);
    this.addChild(this.rig);
    this.addChild(this.mainsheet);
  }

  onTick(dt: GameEventMap["tick"]) {
    // Handle input
    const [steer, sheet] = this.game!.io.getMovementVector();

    // Update rudder steering
    this.rudder.setSteer(steer, dt);

    // Update mainsheet (W = sheet in, S = ease out)
    this.mainsheet.setSheet(-sheet, dt);
  }

  onKeyDown({ key }: GameEventMap["keyDown"]) {
    if (key === "Space") {
      this.wait(ROW_DURATION, (dt, t) => {
        this.hull.body.applyForce(polarToVec(this.hull.body.angle, ROW_FORCE));
      });
    }
  }

  getPosition(): V2d {
    return this.hull.getPosition();
  }
}
