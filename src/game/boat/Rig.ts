import { BaseEntity } from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { RevoluteConstraint } from "../../core/physics/constraints/RevoluteConstraint";
import { Box } from "../../core/physics/shapes/Box";
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

  /** Bowsprit tip in hull-local coords — set by Boat for forestay rendering */
  forestayTarget: V2d = V(11, 0);

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
    // Position at the mast's world-space location so constraints aren't violated at spawn
    const mastWorld = hull.body.toWorldFrame(mastPosition);
    this.body = new DynamicBody({
      mass: boomMass,
      position: [mastWorld.x, mastWorld.y],
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
        getRenderOffset: () => this.hull.tiltTransform.worldOffset(3),
      }),
    );
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [hx, hy] = this.hull.body.position;
    const hullAngle = this.hull.body.angle;
    const [mx, my] = this.getMastWorldPosition();
    const t = this.hull.tiltTransform;

    const mastTopLocal = t.localOffset(20);
    const mastTopWorld = t.worldOffset(20);
    const boomOff = t.worldOffset(3);
    const riggingColor = 0x444444;
    const riggingWidth = 0.15;

    // 1. Boom (bottom layer)
    draw.at(
      { pos: V(mx + boomOff.x, my + boomOff.y), angle: this.body.angle },
      () => {
        draw.fillRect(
          -this.boomLength,
          -this.boomWidth / 2,
          this.boomLength,
          this.boomWidth,
          { color: this.boomColor },
        );
        draw.fillCircle(-this.boomLength, 0, 0.3, { color: 0x664422 });
      },
    );

    // 2. Standing rigging (above boom)
    // Scale y-coords of deck attachment points by cosRoll to match hull foreshortening
    const cr = t.cosRoll;
    draw.at({ pos: V(hx, hy), angle: hullAngle }, () => {
      const lmx = this.mastPosition.x;
      const lmy = this.mastPosition.y;
      const topLX = lmx + mastTopLocal.x;
      const topLY = lmy + mastTopLocal.y;

      // Forestay — mast top to bowsprit tip
      draw.line(
        topLX,
        topLY,
        this.forestayTarget.x,
        this.forestayTarget.y * cr,
        { color: riggingColor, width: riggingWidth },
      );
      // Port shroud
      draw.line(topLX, topLY, lmx - 1, 3 * cr, {
        color: riggingColor,
        width: riggingWidth,
      });
      // Starboard shroud
      draw.line(topLX, topLY, lmx - 1, -3 * cr, {
        color: riggingColor,
        width: riggingWidth,
      });
      // Backstay
      draw.line(topLX, topLY, -6, 0, {
        color: riggingColor,
        width: riggingWidth,
      });
    });

    // 3. Mast (on top of everything)
    draw.line(mx, my, mx + mastTopWorld.x, my + mastTopWorld.y, {
      color: this.mastColor,
      width: 0.4,
    });
    draw.fillCircle(mx, my, 0.3, { color: this.mastColor });
    draw.fillCircle(mx + mastTopWorld.x, my + mastTopWorld.y, 0.2, {
      color: this.mastColor,
    });
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
