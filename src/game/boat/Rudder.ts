import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp, stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import {
  computeFluidForces,
  FluidForceResult,
  foilDrag,
  foilLift,
  RUDDER_CHORD,
} from "../fluid-dynamics";
import { WaterQuery } from "../world/water/WaterQuery";
import type { BuoyantBody } from "./BuoyantBody";
import { RudderConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Rudder extends BaseEntity {
  layer = "boat" as const;

  private steer: number = 0; // -1 to 1 (player input position)
  private effectiveSteer: number = 0; // -1 to 1 (actual position including damage bias)
  private steerInput: number = 0; // Current steering input from controller
  private fastMode: boolean = false;
  private getSteeringMultiplier: () => number = () => 1;
  private getSteeringBias: () => number = () => 0;

  private position: V2d;
  private length: number;
  private maxSteerAngle: number;
  private steerAdjustSpeed: number;
  private steerAdjustSpeedFast: number;
  private color: number;
  private rudderZ: number;

  // Water query for rudder endpoints (transforms to world space for query)
  private waterQuery = this.addChild(
    new WaterQuery(() => this.getQueryPoints()),
  );

  // Cached water velocities indexed by world position key
  private velocityCache = new Map<string, V2d>();

  // Pre-allocated force result buffer
  private forceResults: FluidForceResult[] = [
    { fx: 0, fy: 0, localX: 0, localY: 0 },
    { fx: 0, fy: 0, localX: 0, localY: 0 },
  ];

  constructor(
    private hull: Hull,
    private buoyantBody: BuoyantBody,
    config: RudderConfig,
  ) {
    super();

    this.position = config.position;
    this.length = config.length;
    this.maxSteerAngle = config.maxSteerAngle;
    this.steerAdjustSpeed = config.steerAdjustSpeed;
    this.steerAdjustSpeedFast = config.steerAdjustSpeedFast;
    this.color = config.color;
    this.rudderZ = -config.draft;
  }

  /**
   * Get query points in world space for rudder pivot and end.
   */
  private getQueryPoints(): V2d[] {
    // Calculate rudder end position based on effective steering angle (includes damage bias)
    const rudderOffset = V(-this.length, 0).irotate(
      -this.effectiveSteer * this.maxSteerAngle,
    );
    const rudderEnd = this.position.add(rudderOffset);

    // Transform both points to world space
    return [
      this.hull.body.toWorldFrame(this.position),
      this.hull.body.toWorldFrame(rudderEnd),
    ];
  }

  /**
   * Set steering input. The rudder will smoothly adjust toward the target in onTick.
   * @param input -1 to 1 where negative = steer left, positive = steer right
   * @param fast Whether to use fast adjustment speed
   */
  setSteer(input: number, fast: boolean = false) {
    this.steerInput = input;
    this.fastMode = fast;
  }

  getSteer(): number {
    return this.steer;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    // Update steering position based on input
    if (this.steerInput !== 0) {
      const target = this.steerInput < 0 ? -1 : 1;
      const baseSpeed = this.fastMode
        ? this.steerAdjustSpeedFast
        : this.steerAdjustSpeed;
      const speed = Math.abs(this.steerInput) * baseSpeed;
      this.steer = stepToward(this.steer, target, speed * dt);
    }

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

    // Apply damage bias to effective steer (pulls rudder to one side)
    this.effectiveSteer = clamp(this.steer + this.getSteeringBias(), -1, 1);
    const effectiveSteer = this.effectiveSteer;

    // Calculate rudder end position based on steering angle
    const rudderOffset = V(-this.length, 0).irotate(
      -effectiveSteer * this.maxSteerAngle,
    );
    const rudderEnd = this.position.add(rudderOffset);

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

    // Apply rudder forces to hull (both directions)
    // Forces applied at rudderZ depth for correct 3D torque
    for (const [a, b] of [
      [this.position, rudderEnd],
      [rudderEnd, this.position],
    ] as const) {
      const count = computeFluidForces(
        this.hull.body,
        a,
        b,
        lift,
        drag,
        getWaterVelocity,
        this.forceResults,
      );
      for (let i = 0; i < count; i++) {
        const r = this.forceResults[i];
        this.buoyantBody.applyForce3D(
          r.fx,
          r.fy,
          0,
          r.localX,
          r.localY,
          this.rudderZ,
        );
      }
    }
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [x, y] = this.hull.body.position;
    const [rx, ry] = this.position.rotate(this.hull.body.angle).iadd([x, y]);
    const rudderAngle =
      this.hull.body.angle - this.effectiveSteer * this.maxSteerAngle;

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

  /** Get rudder position in hull-local coordinates */
  getPosition(): V2d {
    return this.position;
  }

  /** Get the current tiller angle offset (same as rudder, they're on the same shaft) */
  getTillerAngleOffset(): number {
    return -this.effectiveSteer * this.maxSteerAngle;
  }

  setDamageEffects(
    steeringMultiplier: () => number,
    steeringBias: () => number,
  ): void {
    this.getSteeringMultiplier = steeringMultiplier;
    this.getSteeringBias = steeringBias;
  }
}
