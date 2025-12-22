import { Body, Convex } from "p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import Entity from "../core/entity/Entity";
import { createGraphics, GameSprite } from "../core/entity/GameSprite";
import { pairs } from "../core/util/FunctionalUtils";
import { polarToVec } from "../core/util/MathUtil";
import { V, V2d } from "../core/Vector";
import {
  applyLiftAndDragToBody,
  applyLiftAndDragToEdge,
} from "./lift-and-drag";

const BOAT_VERTICES = [
  V(-20, -10),
  V(20, -10),
  V(25, 0),
  V(20, 10),
  V(-20, 10),
  V(-25, 0),
];

const KEEL_VERTICES = [V(-15, 0), V(0, 0), V(15, 0)];
const KEEL_LIFT_AND_DRAG = 1.0;

const RUDDER_POSITION = V(-10, 0);
const RUDDER_LENGTH = 18;
const RUDDER_LIFT_AND_DRAG = 1.0;

const HULL_LIFT_AND_DRAG = 0.0;

const MAX_STEER_ANGLE = 0.1; // radians

export class Boat extends BaseEntity {
  id = "boat";

  hull: NonNullable<Entity["body"]>;
  hullSprite: GameSprite & Graphics;
  rudderSprite: GameSprite & Graphics;

  constructor() {
    super();

    this.hullSprite = createGraphics("main");
    this.hullSprite.poly(BOAT_VERTICES).fill({ color: 0xccaa33 });

    this.rudderSprite = createGraphics("main");
    this.rudderSprite
      .poly(KEEL_VERTICES, false)
      .stroke({ color: 0x998833, width: 4 });

    this.hull = new Body({
      mass: 1,
    });

    this.hull.addShape(
      new Convex({
        vertices: [...BOAT_VERTICES],
      })
    );

    this.bodies = [this.hull];
    this.sprites = [this.hullSprite, this.rudderSprite];
  }

  onTick() {
    // Magic movement force
    const [steer, thrust] = this.game!.io.getMovementVector();
    this.hull.applyForce(polarToVec(this.hull.angle, -thrust * 500));

    applyLiftAndDragToBody(this.hull, HULL_LIFT_AND_DRAG, HULL_LIFT_AND_DRAG);

    // keel
    for (const [start, end] of pairs(KEEL_VERTICES)) {
      applyLiftAndDragToEdge(
        this.hull,
        start,
        end,
        KEEL_LIFT_AND_DRAG,
        KEEL_LIFT_AND_DRAG
      );
    }

    // rudder
    const rudderOffset = V(-RUDDER_LENGTH, 0).irotate(steer * MAX_STEER_ANGLE);
    const rudderEnd = RUDDER_POSITION.add(rudderOffset);
    applyLiftAndDragToEdge(this.hull, RUDDER_POSITION, rudderEnd, 0.0, 1.0);
    applyLiftAndDragToEdge(this.hull, rudderEnd, RUDDER_POSITION, 0.0, 1.0);
  }

  getPosition(): V2d {
    return V(this.hull.position);
  }

  onRender() {
    const [steer, thrust] = this.game!.io.getMovementVector();

    const [x, y] = this.hull.position;
    this.hullSprite.position.set(x, y);
    this.hullSprite.rotation = this.hull.angle;

    const [rx, ry] = RUDDER_POSITION.rotate(this.hull.angle).iadd([x, y]);

    this.rudderSprite.position.set(rx, ry);
    this.rudderSprite.rotation = this.hull.angle + steer * MAX_STEER_ANGLE;
  }
}
