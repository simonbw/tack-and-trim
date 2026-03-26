import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { RevoluteConstraint } from "../../core/physics/constraints/RevoluteConstraint";
import { Box } from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForces,
  foilDrag,
  foilLift,
  RUDDER_CHORD,
} from "../fluid-dynamics";
import { WaterQuery } from "../world/water/WaterQuery";
import { RudderConfig } from "./BoatConfig";
import { Hull } from "./Hull";

// Rudder body mass — light enough to respond quickly to input,
// heavy enough for the constraint solver to be stable.
const RUDDER_MASS = 5; // lbs

// Torque applied by player input to turn the rudder
const STEER_TORQUE = 8000;
const STEER_TORQUE_FAST = 20000;

// Angular damping on the rudder body so it doesn't oscillate wildly
const RUDDER_ANGULAR_DAMPING = 0.98;

// Centering torque that gently returns rudder to center when no input
const CENTERING_STIFFNESS = 200;

export class Rudder extends BaseEntity {
  layer = "boat" as const;

  body: DynamicBody;
  private rudderConstraint: RevoluteConstraint;

  private steerInput: number = 0; // Current steering input from controller
  private fastMode: boolean = false;
  private getSteeringMultiplier: () => number = () => 1;
  private getSteeringBias: () => number = () => 0;

  private pivotPosition: V2d; // hull-local position of rudder pivot
  private length: number;
  private maxSteerAngle: number;
  private color: number;

  // Water query for rudder endpoints (transforms to world space for query)
  private waterQuery = this.addChild(
    new WaterQuery(() => this.getQueryPoints()),
  );

  // Cached water velocities indexed by world position key
  private velocityCache = new Map<string, V2d>();

  constructor(
    private hull: Hull,
    config: RudderConfig,
  ) {
    super();

    this.pivotPosition = config.position;
    this.length = config.length;
    this.maxSteerAngle = config.maxSteerAngle;
    this.color = config.color;

    // Create a dynamic body for the rudder blade.
    // The pivot is at the body's origin (0,0 in local space).
    // The blade extends in the -x direction (aft).
    const pivotWorld = hull.body.toWorldFrame(config.position);
    this.body = new DynamicBody({
      mass: RUDDER_MASS,
      position: [pivotWorld.x, pivotWorld.y],
      angularDamping: RUDDER_ANGULAR_DAMPING,
      allowSleep: false,
    });
    this.body.angle = hull.body.angle;

    // Small box shape for the rudder blade
    this.body.addShape(
      new Box({ width: config.length, height: 0.4 }),
      [-config.length / 2, 0],
    );

    // Revolute constraint: attach rudder to hull at the pivot point
    this.rudderConstraint = new RevoluteConstraint(hull.body, this.body, {
      localPivotA: [config.position.x, config.position.y],
      localPivotB: [0, 0],
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
    const relAngle = this.body.angle - this.hull.body.angle;
    if (this.maxSteerAngle === 0) return 0;
    return -(relAngle / this.maxSteerAngle);
  }

  /** Get the actual angle of the rudder relative to the hull */
  private getRelativeAngle(): number {
    return this.body.angle - this.hull.body.angle;
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

    // Centering torque: gently return rudder to center when no input
    const relAngle = this.getRelativeAngle();
    const relAngVel = this.body.angularVelocity - this.hull.body.angularVelocity;
    const centeringTorque =
      this.steerInput === 0
        ? -CENTERING_STIFFNESS * relAngle - CENTERING_STIFFNESS * 0.3 * relAngVel
        : 0;

    this.body.angularForce += steerTorque + biasTorque + centeringTorque;

    // Scale rudder effectiveness by heel angle — rudder lifts out at extreme heel
    const heelFactor = Math.cos(this.hull.tiltRoll);
    const effectiveChord = RUDDER_CHORD * Math.max(0.1, heelFactor);

    // Use proper foil physics with heel-adjusted chord dimension
    // Damage reduces lift (steering authority) but not drag
    const steeringMultiplier = this.getSteeringMultiplier();
    const baseLift = foilLift(effectiveChord);
    const lift: typeof baseLift = (params) =>
      baseLift(params) * steeringMultiplier;
    const drag = foilDrag(effectiveChord);

    // Get water velocity from cache or default to zero
    const getWaterVelocity = (point: V2d): V2d => {
      const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      return this.velocityCache.get(key) ?? V(0, 0);
    };

    // Apply rudder forces to the rudder body (constraint transfers them to hull).
    // v1/v2 are in rudder-body-local coordinates: pivot at origin, tip at (-length, 0).
    const pivotLocal = V(0, 0);
    const tipLocal = V(-this.length, 0);

    applyFluidForces(
      this.body,
      pivotLocal,
      tipLocal,
      lift,
      drag,
      getWaterVelocity,
    );
    applyFluidForces(
      this.body,
      tipLocal,
      pivotLocal,
      lift,
      drag,
      getWaterVelocity,
    );
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    // Use the actual rudder body position and angle for rendering
    const [rx, ry] = this.body.position;
    const rudderAngle = this.body.angle;

    // Rudder is below waterline — small parallax shift
    const offset = this.hull.tiltTransform.worldOffset(-1);

    // Draw rudder blade (underwater)
    draw.at(
      { pos: V(rx + offset.x, ry + offset.y), angle: rudderAngle },
      () => {
        draw.line(0, 0, -this.length, 0, {
          color: this.color,
          width: 0.5,
          z: -1,
        });
      },
    );
  }

  /** Get rudder pivot position in hull-local coordinates */
  getPosition(): V2d {
    return this.pivotPosition;
  }

  /** Get the current tiller angle offset (actual angle from physics) */
  getTillerAngleOffset(): number {
    return this.getRelativeAngle();
  }

  setDamageEffects(
    steeringMultiplier: () => number,
    steeringBias: () => number,
  ): void {
    this.getSteeringMultiplier = steeringMultiplier;
    this.getSteeringBias = steeringBias;
  }
}
