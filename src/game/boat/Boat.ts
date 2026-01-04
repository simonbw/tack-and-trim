import BaseEntity from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { polarToVec } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Hull } from "./Hull";
import { JibSheets } from "./JibSheets";
import { Keel } from "./Keel";
import { Mainsheet } from "./Mainsheet";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";
import { Sail } from "./Sail";

const MAST_POSITION = V(5, 0);
const JIB_HEAD_POSITION = V(5, 0); // At mast (hull-local)
const JIB_TACK_POSITION = V(26, 0); // Near bow (hull-local)

const ROW_DURATION = 0.6; // seconds per row
const ROW_FORCE = 500; // force per row

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  mainsheet: Mainsheet;
  jib!: Sail;
  jibSheets!: JibSheets;

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

    // Jib is created in onAdd() since it needs hull body reference
  }

  onAdd() {
    // Add all children - they will be registered with the game
    this.addChild(this.hull);
    this.addChild(this.keel);
    this.addChild(this.rudder);
    this.addChild(this.rig);
    this.addChild(this.mainsheet);

    // Helper to transform hull-local position to world
    const toWorld = (localPos: V2d): V2d => {
      const [hx, hy] = this.hull.body.position;
      return localPos.rotate(this.hull.body.angle).iadd([hx, hy]);
    };

    // Compute initial clew position for jib setup
    // Chain goes tack → clew, so clew is offset from tack
    const computeInitialClew = (): V2d => {
      const tack = toWorld(JIB_TACK_POSITION);
      const head = toWorld(JIB_HEAD_POSITION);
      // Foot direction: perpendicular to luff, toward stern
      const luff = tack.sub(head);
      const footDir = luff.rotate90cw().normalize();
      // Clew is roughly 15 units along foot, slightly back toward stern
      return tack.add(footDir.mul(15)).add(V(-5, 0).rotate(this.hull.body.angle));
    };

    // Create jib sail with config
    // Particle chain goes tack → clew (the foot), matching mainsail's approach
    this.jib = this.addChild(
      new Sail({
        getHeadPosition: () => toWorld(JIB_TACK_POSITION), // Chain starts at tack
        getInitialClewPosition: computeInitialClew,
        // getClewPosition omitted - defaults to reading from clew particle
        headConstraint: {
          body: this.hull.body,
          localAnchor: JIB_TACK_POSITION, // Tack constrained to bow
        },
        // No clewConstraint - clew is free, controlled by sheets
        sailShape: "triangle",
        billowOuter: 1.5,
        extraPoints: () => [toWorld(JIB_HEAD_POSITION)], // Masthead - forms the leech
      })
    );

    // Create jib sheets connecting clew to hull
    this.jibSheets = new JibSheets(this.hull, this.jib.getClew());
    this.addChild(this.jibSheets);
  }

  onTick(dt: GameEventMap["tick"]) {
    const io = this.game!.io;

    // Handle input
    const [steer, sheet] = io.getMovementVector();

    // Update rudder steering
    this.rudder.setSteer(steer, dt);

    // Update mainsheet (W = sheet in, S = ease out)
    this.mainsheet.setSheet(-sheet, dt);

    // Jib sheet controls: Q = port, E = starboard
    // SHIFT + Q/E = ease out (release), Q/E alone = pull in
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    if (shiftHeld) {
      // Ease mode: release sheets
      const portEase = io.isKeyDown("KeyQ") ? 1 : 0;
      const starboardEase = io.isKeyDown("KeyE") ? 1 : 0;
      this.jibSheets.adjustPortSheet(portEase, dt);
      this.jibSheets.adjustStarboardSheet(starboardEase, dt);
    } else {
      // Trim mode: pull sheets in
      const portPull = io.isKeyDown("KeyQ") ? -1 : 0;
      const starboardPull = io.isKeyDown("KeyE") ? -1 : 0;
      this.jibSheets.adjustPortSheet(portPull, dt);
      this.jibSheets.adjustStarboardSheet(starboardPull, dt);
    }
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

  getVelocity(): V2d {
    return V(this.hull.body.velocity);
  }
}
