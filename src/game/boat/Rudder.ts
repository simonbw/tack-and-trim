import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { degToRad, stepToward } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import {
  applyFluidForces,
  flatPlateDrag,
  flatPlateLift,
} from "../fluid-dynamics";
import { Hull } from "./Hull";

const RUDDER_POSITION = V(-10, 0);
const RUDDER_LENGTH = 18;
const RUDDER_LIFT_AND_DRAG = 10.0;
const MAX_STEER_ANGLE = degToRad(35);
const STEER_ADJUST_SPEED = 1.5; // How fast the rudder position changes with input

export class Rudder extends BaseEntity {
  private rudderSprite: GameSprite & Graphics;
  private steer: number = 0; // -1 to 1

  constructor(private hull: Hull) {
    super();

    this.rudderSprite = createGraphics("underhull");
    this.rudderSprite
      .lineTo(-RUDDER_LENGTH, 0)
      .stroke({ color: 0x665599, width: 2 });

    this.sprite = this.rudderSprite;
  }

  /**
   * Adjust rudder position based on player input.
   * @param input -1 to 1 where negative = steer left, positive = steer right
   * @param dt Delta time in seconds
   */
  setSteer(input: number, dt: number) {
    if (input === 0) return; // No input, hold current position

    // Calculate target: input determines direction
    const target = input < 0 ? -1 : 1;

    // Smoothly adjust rudder position
    const speed = Math.abs(input) * STEER_ADJUST_SPEED;
    this.steer = stepToward(this.steer, target, speed * dt);
  }

  getSteer(): number {
    return this.steer;
  }

  onTick() {
    // Calculate rudder end position based on steering angle
    const rudderOffset = V(-RUDDER_LENGTH, 0).irotate(
      -this.steer * MAX_STEER_ANGLE
    );
    const rudderEnd = RUDDER_POSITION.add(rudderOffset);

    const lift = flatPlateLift(RUDDER_LIFT_AND_DRAG);
    const drag = flatPlateDrag(RUDDER_LIFT_AND_DRAG);

    // Apply rudder forces to hull (both directions)
    applyFluidForces(this.hull.body, RUDDER_POSITION, rudderEnd, lift, drag);
    applyFluidForces(this.hull.body, rudderEnd, RUDDER_POSITION, lift, drag);
  }

  onRender() {
    const [x, y] = this.hull.body.position;
    const [rx, ry] = RUDDER_POSITION.rotate(this.hull.body.angle).iadd([x, y]);

    this.rudderSprite.position.set(rx, ry);
    this.rudderSprite.rotation =
      this.hull.body.angle - this.steer * MAX_STEER_ANGLE;
  }
}
