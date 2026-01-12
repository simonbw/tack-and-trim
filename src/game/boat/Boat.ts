import BaseEntity from "../../core/entity/BaseEntity";
import { polarToVec } from "../../core/util/MathUtil";
import { ReadonlyV2d, V, V2d } from "../../core/Vector";
import { BoatSpray } from "../BoatSpray";
import { Wake } from "../water/Wake";
import { Anchor } from "./Anchor";
import { BoatConfig, StarterDinghy } from "./BoatConfig";
import { BoatWaterQuerier } from "./BoatWaterQuerier";
import { Bowsprit } from "./Bowsprit";
import { Hull } from "./Hull";
import { Keel } from "./Keel";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";
import { Sail } from "./Sail";
import { Sheet } from "./Sheet";

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  bowsprit: Bowsprit;
  jib: Sail;
  anchor: Anchor;
  mainsheet: Sheet;
  portJibSheet: Sheet;
  starboardJibSheet: Sheet;

  readonly config: BoatConfig;

  // Derived positions (computed from config)
  private bowspritTipPosition: V2d;
  private jibHeadPosition: V2d;
  private jibTackPosition: V2d;

  getPosition(): V2d {
    return this.hull.body.position;
  }

  getVelocity(): ReadonlyV2d {
    return this.hull.body.velocity;
  }

  get toWorldFrame() {
    return this.hull.body.toWorldFrame.bind(this.hull.body);
  }

  constructor(config: BoatConfig = StarterDinghy) {
    super();

    this.config = config;

    // Compute derived positions from config
    this.bowspritTipPosition = config.bowsprit.attachPoint.add([
      config.bowsprit.size.x,
      0,
    ]);
    this.jibHeadPosition = config.rig.mastPosition;
    this.jibTackPosition = this.bowspritTipPosition;

    // Create hull first - everything attaches to it
    this.hull = this.addChild(new Hull(config.hull));

    // Create parts that attach to hull
    this.keel = this.addChild(new Keel(this.hull, config.keel));
    this.rudder = this.addChild(new Rudder(this.hull, config.rudder));
    this.rig = this.addChild(new Rig(this.hull, config.rig));

    // Wire up tiller rendering (drawn by hull, but follows rudder angle)
    this.hull.setTillerConfig({
      position: this.rudder.getPosition(),
      getTillerAngle: () => this.rudder.getTillerAngleOffset(),
    });
    this.bowsprit = this.addChild(new Bowsprit(this, config.bowsprit));

    // Create mainsheet (boom to hull)
    const { hullAttachPoint, boomAttachRatio, ...mainsheetConfig } =
      config.mainsheet;
    this.mainsheet = this.addChild(
      new Sheet(
        this.rig.body,
        V(-this.rig.getBoomLength() * boomAttachRatio, 0),
        this.hull.body,
        hullAttachPoint,
        mainsheetConfig,
      ),
    );

    // Compute initial clew position for jib
    const tack = this.toWorldFrame(this.jibTackPosition);
    const head = this.toWorldFrame(this.jibHeadPosition);
    const footDir = tack.sub(head).irotate90cw().inormalize();
    const initialClewPosition = tack
      .addScaled(footDir, 5)
      .iadd(V(-1.5, 0).irotate(this.hull.body.angle));

    // Create jib sail
    this.jib = this.addChild(
      new Sail({
        ...config.jib,
        getHeadPosition: () => this.toWorldFrame(this.jibTackPosition),
        initialClewPosition,
        headConstraint: {
          body: this.hull.body,
          localAnchor: this.jibTackPosition,
        },
        sailShape: "triangle",
        extraPoints: () => [this.toWorldFrame(this.jibHeadPosition)],
      }),
    );

    // Create jib sheets (clew to hull, port and starboard)
    const { portAttachPoint, starboardAttachPoint, ...jibSheetConfig } =
      config.jibSheet;
    const clewBody = this.jib.getClew();

    this.portJibSheet = this.addChild(
      new Sheet(
        clewBody,
        V(0, 0),
        this.hull.body,
        portAttachPoint,
        jibSheetConfig,
      ),
    );

    this.starboardJibSheet = this.addChild(
      new Sheet(clewBody, V(0, 0), this.hull.body, starboardAttachPoint, {
        ...jibSheetConfig,
      }),
    );
    this.starboardJibSheet.release();

    // Create anchor
    this.anchor = this.addChild(new Anchor(this.hull, config.anchor));

    // Create wake and spray effects
    // TODO: Compute these points from the end of the hull
    this.addChild(new Wake(this, V(-6, 2), V(-6, -2))); // Stern wake spawn positions (ft)
    this.addChild(new BoatSpray(this));

    // Create water querier for tile-based GPU water computation
    this.addChild(new BoatWaterQuerier(this));
  }

  onTick(): void {
    // Fade jib sheets based on jib hoist amount
    const jibOpacity = this.jib.getHoistAmount();
    this.portJibSheet.setOpacity(jibOpacity);
    this.starboardJibSheet.setOpacity(jibOpacity);
  }

  /** Row the boat forward */
  row(): void {
    this.wait(this.config.rowing.duration, (dt, t) => {
      this.hull.body.applyForce(
        polarToVec(this.hull.body.angle, this.config.rowing.force),
      );
    });
  }

  /** Toggle sails hoisted/lowered */
  toggleSails(): void {
    const newState = !this.rig.sail.isHoisted();
    this.rig.sail.setHoisted(newState);
    this.jib.setHoisted(newState);
  }
}
