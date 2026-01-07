import { Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../core/entity/GameSprite";
import DynamicBody from "../core/physics/body/DynamicBody";
import Circle from "../core/physics/shapes/Circle";
import { V } from "../core/Vector";
import { WaterInfo } from "./water/WaterInfo";

const BUOY_RADIUS = 6;
const BUOY_MASS = 2;
const BUOYANCY_STRENGTH = 0.5;
const WATER_DAMPING = 0.98;
const WATER_DRAG = 0.1; // How strongly the buoy is pushed by water velocity
const HEIGHT_SCALE_FACTOR = 0.005; // How much surface height affects sprite scale

export class Buoy extends BaseEntity {
  body: DynamicBody;
  private buoySprite: GameSprite & Graphics;

  constructor(x: number, y: number) {
    super();

    // Graphics: red/orange circle with small pole on top
    this.buoySprite = createGraphics("main");
    this.buoySprite
      .circle(0, 0, BUOY_RADIUS)
      .fill({ color: 0xff4422 })
      .stroke({ color: 0xffffff, width: 3, alignment: 1.5 });

    // Physics: circular body
    this.body = new DynamicBody({ mass: BUOY_MASS });
    this.body.addShape(new Circle({ radius: BUOY_RADIUS }));
    this.body.position.set(x, y);

    this.sprite = this.buoySprite;
  }

  onTick() {
    const [x, y] = this.body.position;

    // Simple buoyancy: push up when below water (y > 0)
    if (y > 0) {
      const buoyancyForce = -y * BUOYANCY_STRENGTH;
      this.body.applyForce(V(0, buoyancyForce));
    }

    // Apply water velocity as a drag force (pushes buoy with the current/wake)
    const water = this.game?.entities.getById("waterInfo") as WaterInfo | undefined;
    if (water) {
      const waterState = water.getStateAtPoint(V(x, y));
      // Force proportional to difference between water velocity and buoy velocity
      const relativeVelocity = waterState.velocity.sub(V(this.body.velocity));
      this.body.applyForce(relativeVelocity.mul(WATER_DRAG));
    }

    // Damping to prevent wild oscillation
    this.body.velocity[0] *= WATER_DAMPING;
    this.body.velocity[1] *= WATER_DAMPING;
    this.body.angularVelocity *= WATER_DAMPING;
  }

  onRender() {
    const [x, y] = this.body.position;
    this.buoySprite.position.set(x, y);
    this.buoySprite.rotation = this.body.angle;

    // Scale sprite based on water surface height (simulates bobbing up/down)
    const water = this.game?.entities.getById("waterInfo") as WaterInfo | undefined;
    if (water) {
      const waterState = water.getStateAtPoint(V(x, y));
      const scale = 1 + waterState.surfaceHeight * HEIGHT_SCALE_FACTOR;
      this.buoySprite.scale.set(scale);
    }
  }
}
