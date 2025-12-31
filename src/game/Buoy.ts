import { Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import Entity from "../core/entity/Entity";
import { createGraphics, GameSprite } from "../core/entity/GameSprite";
import Body from "../core/physics/body/Body";
import Circle from "../core/physics/shapes/Circle";
import { V } from "../core/Vector";

const BUOY_RADIUS = 6;
const BUOY_MASS = 2;
const BUOYANCY_STRENGTH = 0.5;
const WATER_DAMPING = 0.98;

export class Buoy extends BaseEntity {
  body: NonNullable<Entity["body"]>;
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
    this.body = new Body({ mass: BUOY_MASS });
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

    // Damping to prevent wild oscillation
    this.body.velocity[0] *= WATER_DAMPING;
    this.body.velocity[1] *= WATER_DAMPING;
    this.body.angularVelocity *= WATER_DAMPING;
  }

  onRender() {
    const [x, y] = this.body.position;
    this.buoySprite.position.set(x, y);
    this.buoySprite.rotation = this.body.angle;
  }
}
