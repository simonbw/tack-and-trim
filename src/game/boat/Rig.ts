import BaseEntity from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import DynamicBody from "../../core/physics/body/DynamicBody";
import RevoluteConstraint from "../../core/physics/constraints/RevoluteConstraint";
import Box from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import { RigConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import { Sail } from "./sail/Sail";

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

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [hx, hy] = this.hull.body.position;
    const hullAngle = this.hull.body.angle;
    const [mx, my] = this.getMastWorldPosition();

    // Draw standing rigging (in hull coordinate space)
    const riggingColor = 0x444444;
    const riggingWidth = 0.15;

    draw.at({ pos: V(hx, hy), angle: hullAngle }, () => {
      const mx = this.mastPosition.x;
      const my = this.mastPosition.y;

      // Forestay - mast to bowsprit tip
      draw.line(mx, my, 11, 0, {
        color: riggingColor,
        width: riggingWidth,
      });

      // Port shroud - mast to chainplate on hull (port side, slightly aft of mast)
      draw.line(mx, my, mx - 1, 3, {
        color: riggingColor,
        width: riggingWidth,
      });

      // Starboard shroud - mast to chainplate on hull (starboard side)
      draw.line(mx, my, mx - 1, -3, {
        color: riggingColor,
        width: riggingWidth,
      });

      // Backstay - mast to stern
      draw.line(mx, my, -6, 0, {
        color: riggingColor,
        width: riggingWidth,
      });
    });

    // Draw boom (rectangle extending from mast)
    draw.at({ pos: V(mx, my), angle: this.body.angle }, () => {
      draw.fillRect(
        -this.boomLength,
        -this.boomWidth / 2,
        this.boomLength,
        this.boomWidth,
        { color: this.boomColor },
      );

      // Boom end cap
      draw.fillCircle(-this.boomLength, 0, 0.3, { color: 0x664422 });
    });

    // Draw mast with outer ring for depth
    draw.strokeCircle(mx, my, 0.6, { color: 0x664422, width: 0.2 });
    draw.fillCircle(mx, my, 0.5, { color: this.mastColor });

    // Gooseneck fitting at boom pivot
    draw.fillCircle(mx, my, 0.25, { color: 0x555555 });
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
