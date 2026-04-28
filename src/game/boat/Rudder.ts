import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { DynamicRigid3D } from "../../core/physics/body/bodyInterfaces";
import type { Body } from "../../core/physics/body/Body";
import { createRigid3D } from "../../core/physics/body/bodyFactories";
import { RevoluteConstraint3D } from "../../core/physics/constraints/RevoluteConstraint3D";
import { Box } from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import {
  computeHydrofoilForces,
  FluidForceResult,
  foilDrag,
  foilLift,
  HydrofoilForceResult,
} from "../fluid-dynamics";
import { WaterQuery } from "../world/water/WaterQuery";
import { RudderConfig } from "./BoatConfig";
import { Hull } from "./Hull";

// Rudder body mass — light enough to respond quickly to input,
// heavy enough for the constraint solver to be stable.
const RUDDER_MASS = 5; // lbs

// Torque applied by player input to turn the rudder
const STEER_TORQUE = 800;
const STEER_TORQUE_FAST = 1200;

// Angular damping on the rudder body so it doesn't oscillate wildly
const RUDDER_ANGULAR_DAMPING = 0.98;

export class Rudder extends BaseEntity {
  layer = "boat" as const;

  body: Body & DynamicRigid3D;
  private rudderConstraint: RevoluteConstraint3D;

  private steerInput: number = 0; // Current steering input from controller
  private fastMode: boolean = false;
  private getSteeringMultiplier: () => number = () => 1;
  private getSteeringBias: () => number = () => 0;

  private pivotPosition: V2d; // hull-local position of rudder pivot
  private length: number;
  private chord: number;
  private maxSteerAngle: number;
  private color: number;
  private tillerColor: number;
  private rudderZ: number;
  private aspectRatio: number; // AR = span / chord (dimensionless)

  // Water query for rudder endpoints (transforms to world space for query)
  private waterQuery = this.addChild(
    new WaterQuery(() => this.getQueryPoints()),
  );

  // Cached water velocities indexed by world position key
  private velocityCache = new Map<string, V2d>();

  // Pre-allocated force result buffers
  private fluidForceResults: FluidForceResult[] = [
    { fx: 0, fy: 0, localX: 0, localY: 0 },
    { fx: 0, fy: 0, localX: 0, localY: 0 },
  ];
  private hydrofoilResults: HydrofoilForceResult[] = Array.from(
    { length: 12 },
    () => ({ fx: 0, fy: 0, fz: 0, localX: 0, localY: 0 }),
  );

  // Pre-allocated rudder vertices in body-local coords (pivot + tip)
  private rudderVertices: V2d[] = [];

  constructor(
    private hull: Hull,
    config: RudderConfig,
  ) {
    super();

    this.pivotPosition = config.position;
    this.length = config.length;
    this.chord = config.chord;
    this.maxSteerAngle = config.maxSteerAngle;
    this.color = config.color;
    this.tillerColor = config.tillerColor;
    this.rudderZ = -config.draft;

    // Aspect ratio = span / chord. Span is the rudder blade depth (draft).
    this.aspectRatio = config.draft / config.chord;

    // Pre-allocate rudder vertices: pivot at origin, tip at (-length, 0)
    this.rudderVertices = [V(0, 0), V(-this.length, 0)];

    // Create a dynamic body for the rudder blade. 6DOF so the 3D revolute
    // joint can lock its orientation (roll/pitch/z) to the hull. The pivot
    // is at the body's origin (0,0 in local space). The blade extends in
    // the -x direction (aft).
    const [pivotWorldX, pivotWorldY, pivotWorldZ] = hull.body.toWorldFrame3D(
      config.position.x,
      config.position.y,
      this.rudderZ,
    );
    this.body = createRigid3D({
      motion: "dynamic",
      mass: RUDDER_MASS,
      position: [pivotWorldX, pivotWorldY],
      angularDamping: RUDDER_ANGULAR_DAMPING,
      allowSleep: false,
      rollInertia: 1,
      pitchInertia: 1,
      zMass: RUDDER_MASS,
      z: pivotWorldZ,
    });
    this.body.angle = hull.body.angle;

    // Small box shape for the rudder blade
    this.body.addShape(new Box({ width: config.length, height: 0.4 }), [
      -config.length / 2,
      0,
    ]);

    // 3D revolute joint: pins the rudder to the hull at the pivot in 3D
    // and locks the rudder's roll/pitch to the hull's, leaving only yaw
    // around the pivot axis free (the steering DOF).
    this.rudderConstraint = new RevoluteConstraint3D(hull.body, this.body, {
      localPivotA: [config.position.x, config.position.y, this.rudderZ],
      localPivotB: [0, 0, 0],
      collideConnected: false,
    });

    // Set angle limits so rudder can't spin freely
    this.rudderConstraint.setLimits(
      -config.maxSteerAngle,
      config.maxSteerAngle,
    );

    this.constraints = [this.rudderConstraint];
  }

  /**
   * Get query points in world space for rudder pivot and end.
   */
  private getQueryPoints(): V2d[] {
    // Pivot is at the body origin, blade tip is at (-length, 0) in body-local space
    const pivotWorld = V(this.body.position);
    const tipWorld = this.body.toWorldFrame(V(-this.length, 0));
    return [pivotWorld, tipWorld];
  }

  /**
   * Set steering input. Applies torque to the rudder body.
   * @param input -1 to 1 where negative = steer left, positive = steer right
   * @param fast Whether to use fast adjustment speed
   */
  setSteer(input: number, fast: boolean = false) {
    this.steerInput = input;
    this.fastMode = fast;
  }

  getSteer(): number {
    // Return normalized steer position based on actual rudder angle
    if (this.maxSteerAngle === 0) return 0;
    return -(this.rudderConstraint.getRelativeAngle() / this.maxSteerAngle);
  }

  /** Get the actual angle of the rudder relative to the hull */
  private getRelativeAngle(): number {
    return this.rudderConstraint.getRelativeAngle();
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    // Build velocity cache from query results
    this.velocityCache.clear();
    const queryPoints = this.getQueryPoints();
    for (let i = 0; i < this.waterQuery.results.length; i++) {
      const point = queryPoints[i];
      if (point) {
        const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
        this.velocityCache.set(key, this.waterQuery.results[i].velocity);
      }
    }

    // Apply steering torque from player input
    // Negative sign: positive steerInput should rotate rudder in -angle direction
    // (turning the rudder clockwise when viewed from above steers the boat to starboard)
    const torqueMag = this.fastMode ? STEER_TORQUE_FAST : STEER_TORQUE;
    const steerTorque = -this.steerInput * torqueMag;

    // Apply damage bias as a constant torque pulling rudder to one side
    const biasTorque = this.getSteeringBias() * torqueMag * 0.5;

    const totalSteerTorque = steerTorque + biasTorque;
    this.body.angularForce += totalSteerTorque;
    // Counter-torque on hull: the helmsperson is inside the boat, so steering
    // is an internal force — their body absorbs the reaction. Without this,
    // the constraint reaction dumps the full steer torque into the hull as yaw.
    this.hull.body.angularForce -= totalSteerTorque;

    // Scale rudder effectiveness by heel angle — rudder lifts out at extreme heel
    const heelFactor = Math.cos(this.hull.body.roll);
    const effectiveChord = this.chord * Math.max(0.1, heelFactor);

    // Use proper foil physics with heel-adjusted chord dimension
    // Damage reduces lift (steering authority) but not drag
    const steeringMultiplier = this.getSteeringMultiplier();
    const baseLift = foilLift(effectiveChord);
    const lift: typeof baseLift = (params) =>
      baseLift(params) * steeringMultiplier;
    const drag = foilDrag(effectiveChord, this.aspectRatio);

    // Get water velocity from cache or default to zero
    const getWaterVelocity = (point: V2d): V2d => {
      const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      return this.velocityCache.get(key) ?? V(0, 0);
    };

    // Use the hull's roll (the rudder tilts with the hull) and the rudder
    // body's own angle (forces are computed in the rudder's frame).
    const roll = this.hull.body.roll;
    const rudderAngle = this.body.angle;

    // Compute 3D hydrofoil forces with heel decomposition
    const count = computeHydrofoilForces(
      this.body,
      this.rudderVertices,
      roll,
      rudderAngle,
      lift,
      drag,
      getWaterVelocity,
      this.hydrofoilResults,
      this.fluidForceResults,
    );

    // Apply horizontal force to rudder body (constraint transfers to hull
    // with correct yaw torque). Apply vertical force directly to hull body
    // at the rudder pivot, since the 2D constraint can't transfer fz.
    for (let i = 0; i < count; i++) {
      const r = this.hydrofoilResults[i];

      const relPoint = this.body.vectorToWorldFrame(V(r.localX, r.localY));
      this.body.applyForce(V(r.fx, r.fy), relPoint);

      if (r.fz !== 0) {
        this.hull.body.applyForce3D(
          0,
          0,
          r.fz,
          this.pivotPosition.x,
          this.pivotPosition.y,
          this.rudderZ,
        );
      }
    }
  }

  /** Get rudder pivot position in hull-local coordinates */
  getPosition(): V2d {
    return this.pivotPosition;
  }

  /** Get the current tiller angle offset (actual angle from physics) */
  getTillerAngleOffset(): number {
    return this.getRelativeAngle();
  }

  /** Get angular velocity of rudder relative to hull yaw (rad/s). */
  getRelativeAngularVelocity(): number {
    return this.body.angularVelocity - this.hull.body.angularVelocity;
  }

  /** Z-depth of the rudder blade tip. */
  getRudderZ(): number {
    return this.rudderZ;
  }

  /** Rudder blade length (ft). */
  getLength(): number {
    return this.length;
  }

  /** Visual color for the rudder blade. */
  getColor(): number {
    return this.color;
  }

  /** Visual color for the tiller arm above deck. */
  getTillerColor(): number {
    return this.tillerColor;
  }

  setDamageEffects(
    steeringMultiplier: () => number,
    steeringBias: () => number,
  ): void {
    this.getSteeringMultiplier = steeringMultiplier;
    this.getSteeringBias = steeringBias;
  }
}
