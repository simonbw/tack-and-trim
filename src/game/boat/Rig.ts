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
  private mastSprite: GameSprite & Graphics;
  private boomSprite: GameSprite & Graphics;
  private boomConstraint: RevoluteConstraint;
  sail!: Sail;

  private mastPosition: V2d;
  private boomLength: number;

  constructor(
    readonly hull: Hull,
    config: RigConfig
  ) {
    super();

    this.mastPosition = config.mastPosition;
    this.boomLength = config.boomLength;

    // Mast visual (small circle at mast position)
    this.mastSprite = createGraphics("main");
    this.mastSprite.circle(0, 0, 0.5).fill({ color: config.colors.mast }); // ~6 inch diameter

    // Boom visual
    this.boomSprite = createGraphics("main");
    this.boomSprite
      .rect(-config.boomLength, -config.boomWidth / 2, config.boomLength, config.boomWidth)
      .fill({ color: config.colors.boom });

    // Boom physics body - pivot is at origin, boom extends in -x direction
    this.body = new DynamicBody({
      mass: config.boomMass,
      position: [config.mastPosition.x, config.mastPosition.y],
    });
    this.body.addShape(
      new Box({
        width: config.boomLength,
        height: config.boomWidth,
      }),
      [-config.boomLength / 2, 0]
    );

    // Constraint connecting boom to hull at mast position
    this.boomConstraint = new RevoluteConstraint(this.hull.body, this.body, {
      localPivotA: [config.mastPosition.x, config.mastPosition.y],
      localPivotB: [0, 0],
      collideConnected: false,
    });

    this.sprites = [this.boomSprite, this.mastSprite];
    this.constraints = [this.boomConstraint];

    // Create mainsail with config
    this.sail = this.addChild(
      new Sail({
        getHeadPosition: () => this.getMastWorldPosition(),
        getClewPosition: () => this.getBoomEndWorldPosition(),
        headConstraint: { body: this.body, localAnchor: V(0, 0) },
        clewConstraint: { body: this.body, localAnchor: V(-config.boomLength, 0) },
        getForceScale: (t) => 1.0 - t, // Triangular compensation
        nodeCount: config.mainsail.nodeCount,
        nodeMass: config.mainsail.nodeMass,
        slackFactor: config.mainsail.slackFactor,
        liftScale: config.mainsail.liftScale,
        dragScale: config.mainsail.dragScale,
        billowInner: config.mainsail.billowInner,
        billowOuter: config.mainsail.billowOuter,
        windInfluenceRadius: config.mainsail.windInfluenceRadius,
        hoistSpeed: config.mainsail.hoistSpeed,
        color: config.mainsail.color,
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
