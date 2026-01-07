import BaseEntity from "../../core/entity/BaseEntity";
import { polarToVec } from "../../core/util/MathUtil";
import { ReadonlyV2d, V, V2d } from "../../core/Vector";
import { Anchor } from "./Anchor";
import { BoatConfig, StarterDinghy } from "./BoatConfig";
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
  jib!: Sail;
  anchor!: Anchor;

  // Sheets - created in onAdd()
  mainsheet!: Sheet;
  portJibSheet!: Sheet;
  starboardJibSheet!: Sheet;

  // Config
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
    this.jibTackPosition = this.bowspritTipPosition; // At end of bowsprit

    // Create hull first - everything attaches to it
    this.hull = new Hull(config.hull);

    // Create parts that attach to hull
    this.keel = new Keel(this.hull, config.keel);
    this.rudder = new Rudder(this.hull, config.rudder);
    this.rig = new Rig(this.hull, config.rig);
    this.bowsprit = new Bowsprit(this, config.bowsprit);

    // Sheets and jib are created in onAdd() since they need body references
  }

  onAdd() {
    const config = this.config;

    // Add all children - they will be registered with the game
    this.addChild(this.hull);
    this.addChild(this.keel);
    this.addChild(this.rudder);
    this.addChild(this.rig);
    this.addChild(this.bowsprit);

    // Create mainsheet (boom to hull)
    const boomAttachLocal = V(
      -this.rig.getBoomLength() * config.mainsheet.boomAttachRatio,
      0
    );
    this.mainsheet = this.addChild(
      new Sheet(
        this.rig.body,
        boomAttachLocal,
        this.hull.body,
        config.mainsheet.hullAttachPoint,
        {
          minLength: config.mainsheet.minLength,
          maxLength: config.mainsheet.maxLength,
          defaultLength: config.mainsheet.defaultLength,
          trimSpeed: config.mainsheet.trimSpeed,
          easeSpeed: config.mainsheet.easeSpeed,
        }
      )
    );

    // Compute initial clew position for jib setup
    // Chain goes tack → clew, so clew is offset from tack
    const computeInitialClew = (): V2d => {
      const tack = this.toWorldFrame(this.jibTackPosition);
      const head = this.toWorldFrame(this.jibHeadPosition);
      // Foot direction: perpendicular to luff, toward stern
      const luff = tack.sub(head);
      const footDir = luff.rotate90cw().normalize();
      // Clew is roughly 5 ft along foot, slightly back toward stern
      return tack
        .add(footDir.mul(5))
        .add(V(-1.5, 0).rotate(this.hull.body.angle));
    };

    // Create jib sail with config
    // Particle chain goes tack → clew (the foot), matching mainsail's approach
    this.jib = this.addChild(
      new Sail({
        getHeadPosition: () => this.toWorldFrame(this.jibTackPosition), // Chain starts at tack
        getInitialClewPosition: computeInitialClew,
        // getClewPosition omitted - defaults to reading from clew particle
        headConstraint: {
          body: this.hull.body,
          localAnchor: this.jibTackPosition, // Tack constrained to bow
        },
        // No clewConstraint - clew is free, controlled by sheets
        sailShape: "triangle",
        billowOuter: config.jib.billowOuter,
        nodeCount: config.jib.nodeCount,
        nodeMass: config.jib.nodeMass,
        slackFactor: config.jib.slackFactor,
        liftScale: config.jib.liftScale,
        dragScale: config.jib.dragScale,
        windInfluenceRadius: config.jib.windInfluenceRadius,
        hoistSpeed: config.jib.hoistSpeed,
        color: config.jib.color,
        extraPoints: () => [this.toWorldFrame(this.jibHeadPosition)], // Masthead - forms the leech
      })
    );

    // Create jib sheets (clew to hull, port and starboard)
    const jibSheetConfig = {
      minLength: config.jibSheet.minLength,
      maxLength: config.jibSheet.maxLength,
      defaultLength: config.jibSheet.defaultLength,
      trimSpeed: config.jibSheet.trimSpeed,
      easeSpeed: config.jibSheet.easeSpeed,
    };
    const clewBody = this.jib.getClew();

    this.portJibSheet = this.addChild(
      new Sheet(
        clewBody,
        V(0, 0),
        this.hull.body,
        config.jibSheet.portAttachPoint,
        jibSheetConfig
      )
    );

    this.starboardJibSheet = this.addChild(
      new Sheet(
        clewBody,
        V(0, 0),
        this.hull.body,
        config.jibSheet.starboardAttachPoint,
        { ...jibSheetConfig, defaultLength: 40 } // Inactive sheet starts slack
      )
    );
    // Inactive starboard sheet starts released
    this.starboardJibSheet.release();

    // Create anchor
    this.anchor = this.addChild(new Anchor(this.hull, config.anchor));
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
      this.hull.body.applyForce(polarToVec(this.hull.body.angle, this.config.rowing.force));
    });
  }

  /** Toggle sails hoisted/lowered */
  toggleSails(): void {
    const newState = !this.rig.sail.isHoisted();
    this.rig.sail.setHoisted(newState);
    this.jib.setHoisted(newState);
  }
}
