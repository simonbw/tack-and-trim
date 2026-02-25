import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { polarToVec } from "../../core/util/MathUtil";
import { ReadonlyV2d, V, V2d } from "../../core/Vector";
import { BoatSpray } from "../BoatSpray";
import { Anchor } from "./Anchor";
import { BoatConfig, StarterBoat } from "./BoatConfig";
import { BoatGrounding } from "./BoatGrounding";
import { Bowsprit } from "./Bowsprit";
import { findBowPoint, findSternPoints, Hull } from "./Hull";
import { Keel } from "./Keel";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";
import { Sail } from "./sail/Sail";
import { Sheet } from "./Sheet";
import { Wake } from "./Wake";

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  bowsprit: Bowsprit;
  jib: Sail | null = null;
  anchor: Anchor;
  mainsheet: Sheet;
  portJibSheet: Sheet | null = null;
  starboardJibSheet: Sheet | null = null;

  readonly config: BoatConfig;

  // Derived positions (computed from config)
  private bowspritTipPosition: V2d;

  getPosition(): V2d {
    return this.hull.body.position;
  }

  getVelocity(): ReadonlyV2d {
    return this.hull.body.velocity;
  }

  get toWorldFrame() {
    return this.hull.body.toWorldFrame.bind(this.hull.body);
  }

  constructor(config: BoatConfig = StarterBoat) {
    super();

    this.config = config;

    // Compute derived positions from config
    this.bowspritTipPosition = config.bowsprit.attachPoint.add([
      config.bowsprit.size.x,
      0,
    ]);
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

    // Create jib and jib sheets if configured
    if (config.jib && config.jibSheet) {
      const jibTackPosition = this.bowspritTipPosition;
      const jibHeadPosition = config.rig.mastPosition;

      // Compute initial clew position for jib
      const tack = this.toWorldFrame(jibTackPosition);
      const head = this.toWorldFrame(jibHeadPosition);
      const footDir = tack.sub(head).irotate90cw().inormalize();
      const initialClewPosition = tack
        .addScaled(footDir, 5)
        .iadd(V(-1.5, 0).irotate(this.hull.body.angle));

      // Create jib sail
      this.jib = this.addChild(
        new Sail({
          ...config.jib,
          getHeadPosition: () => this.toWorldFrame(jibTackPosition),
          initialClewPosition,
          headConstraint: {
            body: this.hull.body,
            localAnchor: jibTackPosition,
          },
          sailShape: "triangle",
          extraPoints: () => [this.toWorldFrame(jibHeadPosition)],
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
    }

    // Create anchor
    this.anchor = this.addChild(new Anchor(this.hull, config.anchor));

    // Create wake effects — bow wave (dominant) and stern wave (weaker)
    const bowPoint = findBowPoint(config.hull.vertices);
    const sternPoints = findSternPoints(config.hull.vertices);
    const sternCenter = sternPoints.port.add(sternPoints.starboard).imul(0.5);
    this.addChild(new Wake(this, bowPoint, 1.0));
    this.addChild(new Wake(this, sternCenter, 0.4));
    this.addChild(new BoatSpray(this));

    // Create terrain querier for grounding physics
    this.addChild(new BoatGrounding(this));
  }

  @on("tick")
  onTick(): void {
    // Fade jib sheets based on jib hoist amount
    if (this.jib && this.portJibSheet && this.starboardJibSheet) {
      const jibOpacity = this.jib.getHoistAmount();
      this.portJibSheet.setOpacity(jibOpacity);
      this.starboardJibSheet.setOpacity(jibOpacity);
    }
  }

  /** Row the boat forward */
  row(): void {
    this.hull.body.applyForce(
      polarToVec(this.hull.body.angle, this.config.rowing.force),
    );
  }

  /** Toggle sails hoisted/lowered */
  toggleSails(): void {
    const newState = !this.rig.sail.isHoisted();
    this.rig.sail.setHoisted(newState);
    this.jib?.setHoisted(newState);
  }
}
