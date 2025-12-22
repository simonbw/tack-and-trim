import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { degToRad, stepToward } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { applyLiftAndDragToEdge } from "../lift-and-drag";
import { Hull } from "./Hull";

const RUDDER_POSITION = V(-10, 0);
const RUDDER_LENGTH = 18;
const RUDDER_LIFT_AND_DRAG = 1.0;
const MAX_STEER_ANGLE = degToRad(30);
const STEER_SPEED = 2.5;

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

  setSteer(value: number, dt: number) {
    this.steer = stepToward(this.steer, value, dt * STEER_SPEED);
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

    // Apply rudder forces to hull (both directions)
    applyLiftAndDragToEdge(
      this.hull.body,
      RUDDER_POSITION,
      rudderEnd,
      RUDDER_LIFT_AND_DRAG,
      RUDDER_LIFT_AND_DRAG
    );
    applyLiftAndDragToEdge(
      this.hull.body,
      rudderEnd,
      RUDDER_POSITION,
      RUDDER_LIFT_AND_DRAG,
      RUDDER_LIFT_AND_DRAG
    );
  }

  onRender() {
    const [x, y] = this.hull.body.position;
    const [rx, ry] = RUDDER_POSITION.rotate(this.hull.body.angle).iadd([x, y]);

    this.rudderSprite.position.set(rx, ry);
    this.rudderSprite.rotation =
      this.hull.body.angle - this.steer * MAX_STEER_ANGLE;
  }
}
