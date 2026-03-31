import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { ReadonlyV2d, V, V2d } from "../../core/Vector";
import { BoatSpray } from "../BoatSpray";
import { Anchor } from "./Anchor";
import { Bilge } from "./Bilge";
import { BoatConfig, StarterBoat } from "./BoatConfig";
import { BoatGrounding } from "./BoatGrounding";
import { BoatSoundGenerator } from "./BoatSoundGenerator";
import { HullDamage } from "./HullDamage";
import { RudderDamage } from "./RudderDamage";
import { SailDamage } from "./SailDamage";
import { Bowsprit } from "./Bowsprit";
import { findBowPoint, findSternPoints, Hull } from "./Hull";
import { Keel } from "./Keel";
import { Lifelines } from "./Lifelines";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";
import { Sail } from "./sail/Sail";
import { Sheet } from "./Sheet";
import { Wake } from "./Wake";
import { Mooring } from "../port/Mooring";

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  bowsprit: Bowsprit | null = null;
  jib: Sail | null = null;
  anchor: Anchor;
  mooring: Mooring;
  bilge: Bilge;
  hullDamage: HullDamage;
  rudderDamage: RudderDamage;
  mainSailDamage: SailDamage;
  jibSailDamage: SailDamage | null = null;
  mainsheet: Sheet;
  portJibSheet: Sheet | null = null;
  starboardJibSheet: Sheet | null = null;

  readonly config: BoatConfig;

  // Convenience accessors for roll/pitch (delegates to hull body's 6DOF state)
  get roll(): number {
    return this.hull.body.roll;
  }
  get pitch(): number {
    return this.hull.body.pitch;
  }
  get rollVelocity(): number {
    return this.hull.body.rollVelocity;
  }
  get pitchVelocity(): number {
    return this.hull.body.pitchVelocity;
  }

  // Derived positions (computed from config)
  private bowspritTipPosition: V2d | null;

  getPosition(): V2d {
    return this.hull.body.position;
  }

  getVelocity(): ReadonlyV2d {
    return this.hull.body.velocity;
  }

  get toWorldFrame() {
    return this.hull.body.toWorldFrame.bind(this.hull.body);
  }

  constructor(
    startPosition: V2d = V(0, 0),
    config: BoatConfig = StarterBoat,
    startRotation: number = 0,
  ) {
    super();

    this.config = config;

    // Compute derived positions from config
    this.bowspritTipPosition = config.bowsprit
      ? config.bowsprit.attachPoint.add([config.bowsprit.size.x, 0])
      : null;
    // Create hull first with 6DOF physics (z, roll, pitch integrated by engine)
    const bc = config.buoyancy;
    this.hull = this.addChild(
      new Hull(
        config.hull,
        {
          rollInertia: bc.rollInertia,
          pitchInertia: bc.pitchInertia,
          zMass: bc.verticalMass,
        },
        bc.verticalMass,
        bc.centerOfGravityZ,
      ),
    );
    // Set hull position BEFORE creating sub-entities so that physics bodies
    // (boom, sail particles, jib particles) are positioned correctly in world space.
    this.hull.body.position.set(startPosition);
    this.hull.body.angle = startRotation;

    // Create parts that attach to hull
    this.keel = this.addChild(
      new Keel(this.hull, config.keel, config.hull.draft),
    );
    this.rudder = this.addChild(new Rudder(this.hull, config.rudder));
    this.rig = this.addChild(new Rig(this.hull, config.rig));

    // Wire up tiller rendering (drawn by hull, but follows rudder angle)
    this.hull.setTillerConfig({
      position: this.rudder.getPosition(),
      getTillerAngle: () => this.rudder.getTillerAngleOffset(),
    });
    if (config.bowsprit) {
      this.bowsprit = this.addChild(new Bowsprit(this, config.bowsprit));
    }

    // Create mainsheet (boom to hull)
    const { hullAttachPoint, boomAttachRatio, ...mainsheetConfig } =
      config.mainsheet;
    const boomZ = config.rig.mainsail.zFoot ?? 3;
    const deckZ = config.hull.deckHeight;
    const getHullBody = () => this.hull.body;
    this.mainsheet = this.addChild(
      new Sheet(
        this.rig.body,
        V(-this.rig.getBoomLength() * boomAttachRatio, 0),
        this.hull.body,
        hullAttachPoint,
        mainsheetConfig,
        getHullBody,
        boomZ,
        deckZ,
      ),
    );

    // Create jib and jib sheets if configured
    if (config.jib && config.jibSheet && this.bowspritTipPosition) {
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
          headLocalPosition: jibTackPosition,
          initialClewPosition,
          headConstraint: {
            body: this.hull.body,
            localAnchor: jibTackPosition,
          },
          sailShape: "triangle",
          getHullBody: () => this.hull.body,
        }),
      );

      // Create jib sheets (clew to hull, port and starboard)
      const { portAttachPoint, starboardAttachPoint, ...jibSheetConfig } =
        config.jibSheet;
      const clewBody = this.jib.getClew();

      const jibClewZ = config.jib.zFoot ?? 3;
      this.portJibSheet = this.addChild(
        new Sheet(
          clewBody,
          V(0, 0),
          this.hull.body,
          portAttachPoint,
          jibSheetConfig,
          getHullBody,
          jibClewZ,
          deckZ,
        ),
      );

      this.starboardJibSheet = this.addChild(
        new Sheet(
          clewBody,
          V(0, 0),
          this.hull.body,
          starboardAttachPoint,
          { ...jibSheetConfig },
          getHullBody,
          jibClewZ,
          deckZ,
        ),
      );
      this.starboardJibSheet.release();
    }

    // Create lifelines (stanchions, pulpits, lifeline wires)
    if (config.lifelines) {
      this.addChild(new Lifelines(this, config.lifelines));
    }

    // Create anchor and mooring
    this.anchor = this.addChild(new Anchor(this.hull, config.anchor));
    this.mooring = this.addChild(new Mooring(this));

    // Create wake effects — bow wave (dominant) and stern wave (weaker)
    // Use waterline vertices for wake spawn points (where hull meets water)
    const waterlineVerts =
      config.hull.waterlineVertices ?? config.hull.vertices;
    const bowPoint = findBowPoint(waterlineVerts);
    const sternPoints = findSternPoints(waterlineVerts);
    const sternCenter = sternPoints.port.add(sternPoints.starboard).imul(0.5);
    this.addChild(new Wake(this, bowPoint, 1.0));
    this.addChild(new Wake(this, sternCenter, 0.4));
    this.addChild(new BoatSpray(this));

    // Create terrain querier for grounding physics
    this.addChild(new BoatGrounding(this));

    // Water accumulation, slosh, and bilge system
    this.bilge = this.addChild(new Bilge(this, config.bilge));

    // Hull damage tracking
    this.hullDamage = this.addChild(new HullDamage(this, config.hullDamage));

    // Wire damage effects to hull friction and bilge leaking
    this.hull.setDamageMultiplier(() =>
      this.hullDamage.getSkinFrictionMultiplier(),
    );
    this.bilge.setHullLeakRate(() => this.hullDamage.getLeakRate());

    // Rudder damage tracking
    this.rudderDamage = this.addChild(
      new RudderDamage(this, config.rudderDamage),
    );

    // Wire rudder damage effects to steering
    this.rudder.setDamageEffects(
      () => this.rudderDamage.getSteeringMultiplier(),
      () => this.rudderDamage.getSteeringBias(),
    );

    // Sail damage tracking (mainsail)
    this.mainSailDamage = this.addChild(
      new SailDamage(
        this,
        config.sailDamage,
        this.rig.sail,
        "main",
        this.mainsheet,
      ),
    );
    this.rig.sail.setDamageMultiplier(() =>
      this.mainSailDamage.getLiftMultiplier(),
    );

    // Sail damage tracking (jib, if present)
    if (this.jib) {
      this.jibSailDamage = this.addChild(
        new SailDamage(
          this,
          config.sailDamage,
          this.jib,
          "jib",
          this.portJibSheet,
        ),
      );
      this.jib.setDamageMultiplier(() =>
        this.jibSailDamage!.getLiftMultiplier(),
      );
    }

    // Boat sound effects (sheet snaps, boom slams)
    this.addChild(new BoatSoundGenerator(this));
  }

  @on("tick")
  onTick({}: GameEventMap["tick"]): void {
    // Fade jib sheets based on jib hoist amount
    if (this.jib && this.portJibSheet && this.starboardJibSheet) {
      const jibOpacity = this.jib.getHoistAmount();
      this.portJibSheet.setOpacity(jibOpacity);
      this.starboardJibSheet.setOpacity(jibOpacity);
    }
  }

  /** Row the boat forward */
  row(): void {
    const angle = this.hull.body.angle;
    const force = this.config.rowing.force;
    this.hull.body.applyForce3D(
      Math.cos(angle) * force,
      Math.sin(angle) * force,
      0,
      0,
      0,
      0,
    );
  }

  /** Toggle sails hoisted/lowered */
  toggleSails(): void {
    const newState = !this.rig.sail.isHoisted();
    this.rig.sail.setHoisted(newState);
    this.jib?.setHoisted(newState);
  }
}
