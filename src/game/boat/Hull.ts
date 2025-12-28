import { Body, Convex } from "p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForcesToBody,
  flatPlateDrag,
  flatPlateLift,
} from "../fluid-dynamics";

export const BOAT_MASS = 5; // kg?

const HULL_VERTICES = [
  // Stern (transom)
  V(-20, -4),
  V(-18, -7),
  // Starboard side
  V(-8, -10),
  V(6, -10),
  V(16, -8),
  V(24, -4),
  // Bow
  V(28, 0),
  // Port side
  V(24, 4),
  V(16, 8),
  V(6, 10),
  V(-8, 10),
  V(-18, 7),
  V(-20, 4),
];

const HULL_LIFT_AND_DRAG = 0.15;

export class Hull extends BaseEntity {
  body: NonNullable<Entity["body"]>;
  private hullSprite: GameSprite & Graphics;

  constructor() {
    super();

    this.hullSprite = createGraphics("hull");
    this.hullSprite
      .roundShape(HULL_VERTICES, 10, true, 1)
      .fill({ color: 0xccaa33 })
      .stroke({ color: 0x886633, width: 1, join: "round" });

    this.body = new Body({
      mass: BOAT_MASS,
    });

    this.body.addShape(
      new Convex({
        vertices: [...HULL_VERTICES],
      })
    );

    this.sprite = this.hullSprite;
  }

  onTick() {
    applyFluidForcesToBody(
      this.body,
      flatPlateLift(HULL_LIFT_AND_DRAG),
      flatPlateDrag(HULL_LIFT_AND_DRAG)
    );
  }

  onRender() {
    const [x, y] = this.body.position;
    this.hullSprite.position.set(x, y);
    this.hullSprite.rotation = this.body.angle;
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }
}
