import BaseEntity from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import DynamicBody from "../../core/physics/body/DynamicBody";
import RevoluteConstraint from "../../core/physics/constraints/RevoluteConstraint";
import Box from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import { RigConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import { Sail } from "./Sail";

export class Rig extends BaseEntity {
  layer = "main" as const;
  body: NonNullable<Entity["body"]>;
  private boomConstraint: RevoluteConstraint;
  sail!: Sail;

  private mastPosition: V2d;
  private boomLength: number;
  private boomWidth: number;
  private mastColor: number;
  private boomColor: number;

  constructor(
    readonly hull: Hull,
    config: RigConfig,
  ) {
    super();

    const { mastPosition, boomLength, boomWidth, boomMass, colors, mainsail } =
      config;

    this.mastPosition = mastPosition;
    this.boomLength = boomLength;
    this.boomWidth = boomWidth;
    this.mastColor = colors.mast;
    this.boomColor = colors.boom;

    // Boom physics body - pivot is at origin, boom extends in -x direction
    this.body = new DynamicBody({
      mass: boomMass,
      position: [mastPosition.x, mastPosition.y],
    });
    this.body.addShape(new Box({ width: boomLength, height: boomWidth }), [
      -boomLength / 2,
      0,
    ]);

    // Constraint connecting boom to hull at mast position
    this.boomConstraint = new RevoluteConstraint(hull.body, this.body, {
      localPivotA: [mastPosition.x, mastPosition.y],
      localPivotB: [0, 0],
      collideConnected: false,
    });

    this.constraints = [this.boomConstraint];

    // Create mainsail
    this.sail = this.addChild(
      new Sail({
        ...mainsail,
        getHeadPosition: () => this.getMastWorldPosition(),
        getClewPosition: () => this.getBoomEndWorldPosition(),
        headConstraint: { body: this.body, localAnchor: V(0, 0) },
        clewConstraint: { body: this.body, localAnchor: V(-boomLength, 0) },
        getForceScale: (t) => 1.0 - t,
      }),
    );
  }

  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [mx, my] = this.getMastWorldPosition();

    // Draw boom (rectangle extending from mast)
    draw.at({ pos: V(mx, my), angle: this.body.angle }, () => {
      draw.rect(
        -this.boomLength,
        -this.boomWidth / 2,
        this.boomLength,
        this.boomWidth,
        { color: this.boomColor },
      );
    });

    // Draw mast (small circle at mast position)
    draw.circle(mx, my, 0.5, { color: this.mastColor });
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
