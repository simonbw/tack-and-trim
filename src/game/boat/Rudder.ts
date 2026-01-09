import BaseEntity from "../../core/entity/BaseEntity";
import { stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces, foilDrag, foilLift } from "../fluid-dynamics";
import { WaterInfo } from "../water/WaterInfo";
import { RudderConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Rudder extends BaseEntity {
  layer = "underhull" as const;

  private steer: number = 0; // -1 to 1
  private steerInput: number = 0; // Current steering input from controller
  private fastMode: boolean = false;

  private position: V2d;
  private length: number;
  private liftAndDrag: number;
  private maxSteerAngle: number;
  private steerAdjustSpeed: number;
  private steerAdjustSpeedFast: number;
  private color: number;

  constructor(
    private hull: Hull,
    config: RudderConfig,
  ) {
    super();

    this.position = config.position;
    this.length = config.length;
    this.liftAndDrag = config.liftAndDrag;
    this.maxSteerAngle = config.maxSteerAngle;
    this.steerAdjustSpeed = config.steerAdjustSpeed;
    this.steerAdjustSpeedFast = config.steerAdjustSpeedFast;
    this.color = config.color;
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

  onTick(dt: number) {
    // Update steering position based on input
    if (this.steerInput !== 0) {
      const target = this.steerInput < 0 ? -1 : 1;
      const baseSpeed = this.fastMode
        ? this.steerAdjustSpeedFast
        : this.steerAdjustSpeed;
      const speed = Math.abs(this.steerInput) * baseSpeed;
      this.steer = stepToward(this.steer, target, speed * dt);
    }

    // Calculate rudder end position based on steering angle
    const rudderOffset = V(-this.length, 0).irotate(
      -this.steer * this.maxSteerAngle,
    );
    const rudderEnd = this.position.add(rudderOffset);

    const lift = foilLift(this.liftAndDrag);
    const drag = foilDrag(this.liftAndDrag);

    // Get water velocity function
    const water = this.game?.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    const getWaterVelocity = (point: V2d): V2d =>
      water?.getStateAtPoint(point).velocity ?? V(0, 0);

    // Apply rudder forces to hull (both directions)
    applyFluidForces(
      this.hull.body,
      this.position,
      rudderEnd,
      lift,
      drag,
      getWaterVelocity,
    );
    applyFluidForces(
      this.hull.body,
      rudderEnd,
      this.position,
      lift,
      drag,
      getWaterVelocity,
    );
  }

  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [x, y] = this.hull.body.position;
    const [rx, ry] = this.position.rotate(this.hull.body.angle).iadd([x, y]);
    const rudderAngle = this.hull.body.angle - this.steer * this.maxSteerAngle;

    // Draw rudder blade (underwater)
    draw.at({ pos: V(rx, ry), angle: rudderAngle }, () => {
      draw.line(0, 0, -this.length, 0, { color: this.color, width: 0.5 });
    });
  }

  /** Get rudder position in hull-local coordinates */
  getPosition(): V2d {
    return this.position;
  }

  /** Get the current tiller angle offset (same as rudder, they're on the same shaft) */
  getTillerAngleOffset(): number {
    return -this.steer * this.maxSteerAngle;
  }
}
