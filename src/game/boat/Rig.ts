import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import DynamicBody from "../../core/physics/body/DynamicBody";
import RevoluteConstraint from "../../core/physics/constraints/RevoluteConstraint";
import Box from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import { RigConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import { Sail } from "./Sail";

export class Rig extends BaseEntity {
  body: NonNullable<Entity["body"]>;
  sail: Sail;

  private mastSprite: GameSprite & Graphics;
  private boomSprite: GameSprite & Graphics;
  private mastPosition: V2d;
  private boomLength: number;

  constructor(
    readonly hull: Hull,
    config: RigConfig
  ) {
    super();

    const { mastPosition, boomLength, boomWidth, boomMass, colors, mainsail } =
      config;

    this.mastPosition = mastPosition;
    this.boomLength = boomLength;

    // Mast visual (small circle at mast position)
    this.mastSprite = createGraphics("main");
    this.mastSprite.circle(0, 0, 0.5).fill({ color: colors.mast });

    // Boom visual
    this.boomSprite = createGraphics("main");
    this.boomSprite
      .rect(-boomLength, -boomWidth / 2, boomLength, boomWidth)
      .fill({ color: colors.boom });

    // Boom physics body - pivot is at origin, boom extends in -x direction
    this.body = new DynamicBody({
      mass: boomMass,
      position: [mastPosition.x, mastPosition.y],
    });
    this.body.addShape(
      new Box({ width: boomLength, height: boomWidth }),
      [-boomLength / 2, 0]
    );

    this.sprites = [this.boomSprite, this.mastSprite];
    this.constraints = [
      new RevoluteConstraint(hull.body, this.body, {
        localPivotA: [mastPosition.x, mastPosition.y],
        localPivotB: [0, 0],
        collideConnected: false,
      }),
    ];

    // Create mainsail
    this.sail = this.addChild(
      new Sail({
        ...mainsail,
        getHeadPosition: () => this.getMastWorldPosition(),
        getClewPosition: () => this.getBoomEndWorldPosition(),
        headConstraint: { body: this.body, localAnchor: V(0, 0) },
        clewConstraint: { body: this.body, localAnchor: V(-boomLength, 0) },
        getForceScale: (t) => 1.0 - t,
      })
    );
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
    return V(-this.boomLength, 0).rotate(this.body.angle).iadd([mx, my]);
  }

  getBoomLength(): number {
    return this.boomLength;
  }
}
