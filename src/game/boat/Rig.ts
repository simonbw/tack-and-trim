import { Body, Box, RevoluteConstraint } from "p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { V, V2d } from "../../core/Vector";
import { applyLiftAndDragToEdge } from "../lift-and-drag";
import { Wind } from "../Wind";
import { Hull } from "./Hull";

const BOOM_LENGTH = 25;
const BOOM_WIDTH = 2;

// Sail physics
const SAIL_LIFT = 0.2;
const SAIL_DRAG = 0.1;
const SAIL_EDGE_START = V(0, 0);
const SAIL_EDGE_END = V(-BOOM_LENGTH, 0);

// Sail visual
const SAIL_DRAFT = 3;
const SAIL_DRAFT_POSITION = 0.4;

export class Rig extends BaseEntity {
  body: NonNullable<Entity["body"]>;
  private mastSprite: GameSprite & Graphics;
  private boomSprite: GameSprite & Graphics;
  private sailSprite: GameSprite & Graphics;
  private boomConstraint: RevoluteConstraint;

  constructor(
    private hull: Hull,
    private mastPosition: V2d
  ) {
    super();

    // Mast visual (small circle at mast position)
    this.mastSprite = createGraphics("main");
    this.mastSprite.circle(0, 0, 3).fill({ color: 0x886633 });

    // Boom visual
    this.boomSprite = createGraphics("main");
    this.boomSprite
      .rect(-BOOM_LENGTH, -BOOM_WIDTH / 2, BOOM_LENGTH, BOOM_WIDTH)
      .fill({ color: 0x997744 });

    // Sail visual
    this.sailSprite = createGraphics("sails");

    // Boom physics body - pivot is at origin, boom extends in -x direction
    this.body = new Body({
      mass: 0.1,
      position: [this.mastPosition.x, this.mastPosition.y],
    });
    this.body.addShape(
      new Box({
        width: BOOM_LENGTH,
        height: BOOM_WIDTH,
      }),
      [-BOOM_LENGTH / 2, 0]
    );

    // Constraint connecting boom to hull at mast position
    this.boomConstraint = new RevoluteConstraint(this.hull.body, this.body, {
      localPivotA: [this.mastPosition.x, this.mastPosition.y],
      localPivotB: [0, 0],
      collideConnected: false,
    });

    this.sprites = [this.boomSprite, this.sailSprite, this.mastSprite];
    this.constraints = [this.boomConstraint];
  }

  onTick() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    const getWindVelocity = (point: V2d) => wind.getVelocityAtPoint(point);

    // Apply wind forces to boom (both directions so sail works on either tack)
    applyLiftAndDragToEdge(
      this.body,
      SAIL_EDGE_START,
      SAIL_EDGE_END,
      SAIL_LIFT,
      SAIL_DRAG,
      getWindVelocity
    );
    applyLiftAndDragToEdge(
      this.body,
      SAIL_EDGE_END,
      SAIL_EDGE_START,
      SAIL_LIFT,
      SAIL_DRAG,
      getWindVelocity
    );
  }

  onRender() {
    const [mx, my] = this.getMastWorldPosition();

    this.mastSprite.position.set(mx, my);
    this.boomSprite.position.set(mx, my);
    this.boomSprite.rotation = this.body.angle;

    // Draw sail triangle
    this.sailSprite.clear();
    this.sailSprite.position.set(mx, my);
    this.sailSprite.rotation = this.body.angle;
    this.sailSprite
      .poly([
        V(0, 0),
        V(-BOOM_LENGTH, 0),
        V(-BOOM_LENGTH * SAIL_DRAFT_POSITION, SAIL_DRAFT),
      ])
      .fill({ color: 0xffffff, alpha: 0.85 });
  }

  getMastWorldPosition(): [number, number] {
    const [x, y] = this.hull.body.position;
    return this.mastPosition.rotate(this.hull.body.angle).iadd([x, y]);
  }

  getBoomLength(): number {
    return BOOM_LENGTH;
  }
}
