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
import { Buoyancy } from "./Buoyancy";
import { BuoyantBody } from "./BuoyantBody";
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

  // 3D vertical physics (z, roll, pitch)
  buoyantBody!: BuoyantBody;

  // Convenience accessors for roll/pitch (delegates to buoyantBody)
  get roll(): number {
    return this.buoyantBody.roll;
  }
  set roll(value: number) {
    this.buoyantBody.roll = value;
  }
  get pitch(): number {
    return this.buoyantBody.pitch;
  }
  set pitch(value: number) {
    this.buoyantBody.pitch = value;
  }
  get rollVelocity(): number {
    return this.buoyantBody.rollVelocity;
  }
  get pitchVelocity(): number {
    return this.buoyantBody.pitchVelocity;
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
    // Create hull first - everything attaches to it
    this.hull = this.addChild(new Hull(config.hull));
    // Set hull position BEFORE creating sub-entities so that physics bodies
    // (boom, sail particles, jib particles) are positioned correctly in world space.
    this.hull.body.position.set(startPosition);
    this.hull.body.angle = startRotation;

    // Create 3D buoyancy body wrapping the hull's 2D physics body
    // Wire it to the hull for distributed skin friction
    const bc = config.buoyancy;
    this.buoyantBody = new BuoyantBody({
      body: this.hull.body,
      verticalMass: bc.verticalMass,
      rollInertia: bc.rollInertia,
      pitchInertia: bc.pitchInertia,
      maxRoll: bc.maxRoll,
      maxPitch: bc.maxPitch,
    });
    this.hull.setBuoyantBody(this.buoyantBody);

    // Create buoyancy entity for multi-point sampling
    const buoyancyWaterlineVerts =
      config.hull.waterlineVertices ?? config.hull.vertices;
    this.addChild(
      new Buoyancy(
        this.buoyantBody,
        this.hull,
        buoyancyWaterlineVerts,
        bc.verticalMass, // boat mass = displacement mass
        bc.centerOfGravityZ,
      ),
    );

    // Create parts that attach to hull
    this.keel = this.addChild(
      new Keel(this.hull, this.buoyantBody, config.keel, config.hull.draft),
    );
    this.rudder = this.addChild(
      new Rudder(this.hull, this.buoyantBody, config.rudder),
    );
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
    const getTilt = () => this.hull.tiltTransform;
    this.mainsheet = this.addChild(
      new Sheet(
        this.rig.body,
        V(-this.rig.getBoomLength() * boomAttachRatio, 0),
        this.hull.body,
        hullAttachPoint,
        mainsheetConfig,
        getTilt,
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
          getTiltTransform: () => this.hull.tiltTransform,
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
          getTilt,
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
          getTilt,
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

  /**
   * Accumulate tilt torque from external sources.
   * Legacy API — delegates to buoyantBody. Prefer calling
   * buoyantBody.applyForce3D() or buoyantBody.applyVerticalTorqueFrom() directly.
   */
  applyTiltTorque(rollTorque: number, pitchTorque: number): void {
    this.buoyantBody.applyTorque(rollTorque, pitchTorque);
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    // Fade jib sheets based on jib hoist amount
    if (this.jib && this.portJibSheet && this.starboardJibSheet) {
      const jibOpacity = this.jib.getHoistAmount();
      this.portJibSheet.setOpacity(jibOpacity);
      this.starboardJibSheet.setOpacity(jibOpacity);
    }

    // Sail heeling torques (vertical torque from forces already applied to 2D body)
    const mainTorque = this.rig.sail.getTiltTorque();
    this.applyTiltTorque(mainTorque.roll, mainTorque.pitch);

    if (this.jib) {
      const jibTorque = this.jib.getTiltTorque();
      this.applyTiltTorque(jibTorque.roll, jibTorque.pitch);
    }

    // --- Integrate vertical DOFs (z, roll, pitch) ---
    // Buoyancy and gravity forces are applied by the Buoyancy entity.
    // Sail, keel, rudder, bilge, grounding forces are applied by their respective entities.
    this.buoyantBody.integrateVertical(dt);
    this.buoyantBody.resetVerticalForces();

    // Propagate tilt to hull for child entities to read
    this.hull.tiltRoll = this.roll;
    this.hull.tiltPitch = this.pitch;

    const [hx, hy] = this.hull.body.position;
    this.hull.tiltTransform.update(
      this.roll,
      this.pitch,
      this.hull.body.angle,
      hx,
      hy,
    );
  }

  /** Row the boat forward */
  row(): void {
    const angle = this.hull.body.angle;
    const force = this.config.rowing.force;
    this.buoyantBody.applyForce3D(
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
