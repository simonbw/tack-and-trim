import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp, polarToVec } from "../../core/util/MathUtil";
import { ReadonlyV2d, V, V2d } from "../../core/Vector";
import { BoatSpray } from "../BoatSpray";
import { WaterQuery } from "../world/water/WaterQuery";
import { Anchor } from "./Anchor";
import { BoatConfig, StarterBoat } from "./BoatConfig";
import { BoatGrounding } from "./BoatGrounding";
import { BoatSoundGenerator } from "./BoatSoundGenerator";
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
  bowsprit: Bowsprit | null = null;
  jib: Sail | null = null;
  anchor: Anchor;
  mainsheet: Sheet;
  portJibSheet: Sheet | null = null;
  starboardJibSheet: Sheet | null = null;

  readonly config: BoatConfig;

  // Tilt state (radians)
  roll: number = 0; // positive = heel toward port (+y)
  pitch: number = 0; // positive = bow up
  rollVelocity: number = 0;
  pitchVelocity: number = 0;

  // Tilt torque accumulators (reset each tick)
  private accumulatedRollTorque: number = 0;
  private accumulatedPitchTorque: number = 0;

  // Water query for wave slope at boat position
  private waterQuery: WaterQuery;

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

  constructor(startPosition: V2d = V(0, 0), config: BoatConfig = StarterBoat) {
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
          initialClewPosition,
          headConstraint: {
            body: this.hull.body,
            localAnchor: jibTackPosition,
          },
          sailShape: "triangle",
          extraPoints: () => [this.toWorldFrame(jibHeadPosition)],
          getTiltTransform: () => this.hull.tiltTransform,
          getRenderOffset: () => this.hull.tiltTransform.worldOffset(3),
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

    // Boat sound effects (sheet snaps, boom slams)
    this.addChild(new BoatSoundGenerator(this));

    // Water query for wave slope (used for tilt wave response)
    this.waterQuery = this.addChild(
      new WaterQuery(() => [V(this.hull.body.position)]),
    );
  }

  /** Accumulate tilt torque from external sources (sails, keel, waves, grounding) */
  applyTiltTorque(rollTorque: number, pitchTorque: number): void {
    this.accumulatedRollTorque += rollTorque;
    this.accumulatedPitchTorque += pitchTorque;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    // Fade jib sheets based on jib hoist amount
    if (this.jib && this.portJibSheet && this.starboardJibSheet) {
      const jibOpacity = this.jib.getHoistAmount();
      this.portJibSheet.setOpacity(jibOpacity);
      this.starboardJibSheet.setOpacity(jibOpacity);
    }

    const tilt = this.config.tilt;
    const hullAngle = this.hull.body.angle;

    // --- Compute tilt torques ---

    // 1. Sail heeling torque: lateral component of sail force × z-height
    // Lateral direction in world frame (perpendicular to boat heading, toward port)
    const lateralX = -Math.sin(hullAngle);
    const lateralY = Math.cos(hullAngle);

    const mainForce = this.rig.sail.getTotalForce();
    const mainLateral = mainForce.x * lateralX + mainForce.y * lateralY;
    this.applyTiltTorque(mainLateral * tilt.zHeights.sailCE, 0);

    if (this.jib) {
      const jibForce = this.jib.getTotalForce();
      const jibLateral = jibForce.x * lateralX + jibForce.y * lateralY;
      this.applyTiltTorque(jibLateral * tilt.zHeights.sailCE, 0);
    }

    // 2. Wave slope torque: water surface normal drives roll and pitch
    if (this.waterQuery.results.length > 0) {
      const waterNormal = this.waterQuery.results[0].normal;
      // Project water normal into boat frame
      const cosA = Math.cos(hullAngle);
      const sinA = Math.sin(hullAngle);
      // Boat-frame x (forward) = world dot forward, boat-frame y (port) = world dot port
      const normalForward = waterNormal.x * cosA + waterNormal.y * sinA;
      const normalLateral = -waterNormal.x * sinA + waterNormal.y * cosA;
      this.applyTiltTorque(
        normalLateral * tilt.waveRollCoeff,
        normalForward * tilt.wavePitchCoeff,
      );
    }

    // 3. Righting moment (restoring torque from keel weight + buoyancy)
    const rightingRoll = -tilt.rightingMomentCoeff * Math.sin(this.roll);
    const rightingPitch = -tilt.pitchRightingCoeff * Math.sin(this.pitch);
    this.applyTiltTorque(rightingRoll, rightingPitch);

    // --- Integrate tilt ---

    // Damping torque (opposes angular velocity)
    const dampingRoll = -tilt.rollDamping * this.rollVelocity;
    const dampingPitch = -tilt.pitchDamping * this.pitchVelocity;

    // Angular acceleration = (torque + damping) / inertia
    const rollAccel =
      (this.accumulatedRollTorque + dampingRoll) / tilt.rollInertia;
    const pitchAccel =
      (this.accumulatedPitchTorque + dampingPitch) / tilt.pitchInertia;

    // Semi-implicit Euler integration
    this.rollVelocity += rollAccel * dt;
    this.pitchVelocity += pitchAccel * dt;
    this.roll += this.rollVelocity * dt;
    this.pitch += this.pitchVelocity * dt;

    // Clamp to max angles
    this.roll = clamp(this.roll, -tilt.maxRoll, tilt.maxRoll);
    this.pitch = clamp(this.pitch, -tilt.maxPitch, tilt.maxPitch);

    // Reset accumulators
    this.accumulatedRollTorque = 0;
    this.accumulatedPitchTorque = 0;

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
