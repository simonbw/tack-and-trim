import { Body, Box, RevoluteConstraint } from "p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { V, V2d } from "../../core/Vector";
import { Hull } from "./Hull";
import { Sail2 } from "./Sail2";

const BOOM_LENGTH = 25;
const BOOM_WIDTH = 2;

export class Rig extends BaseEntity {
  body: NonNullable<Entity["body"]>;
  private mastSprite: GameSprite & Graphics;
  private boomSprite: GameSprite & Graphics;
  private boomConstraint: RevoluteConstraint;
  sail: Sail2;

  constructor(
    private hull: Hull,
    private mastPosition: V2d
  ) {
    super();

    this.sail = this.addChild(new Sail2(this));

    // Mast visual (small circle at mast position)
    this.mastSprite = createGraphics("main");
    this.mastSprite.circle(0, 0, 3).fill({ color: 0x886633 });

    // Boom visual
    this.boomSprite = createGraphics("main");
    this.boomSprite
      .rect(-BOOM_LENGTH, -BOOM_WIDTH / 2, BOOM_LENGTH, BOOM_WIDTH)
      .fill({ color: 0x997744 });

    // Boom physics body - pivot is at origin, boom extends in -x direction
    this.body = new Body({
      mass: 1.0,
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

    this.sprites = [this.boomSprite, this.mastSprite];
    this.constraints = [this.boomConstraint];
  }

  onRender() {
    const [mx, my] = this.getMastWorldPosition();

    this.mastSprite.position.set(mx, my);
    this.boomSprite.position.set(mx, my);
    this.boomSprite.rotation = this.body.angle;
  }

  getMastWorldPosition(): V2d {
    const [x, y] = this.hull.body.position;
    return this.mastPosition.rotate(this.hull.body.angle).iadd([x, y]);
  }

  getBoomEndWorldPosition(): V2d {
    const [mx, my] = this.getMastWorldPosition();
    return V(-BOOM_LENGTH, 0).rotate(this.body.angle).iadd([mx, my]);
  }

  getBoomLength(): number {
    return BOOM_LENGTH;
  }
}
