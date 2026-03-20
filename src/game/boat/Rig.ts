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
  private stays: RigConfig["stays"];

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
    this.stays = config.stays;

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
        getTiltTransform: () => this.hull.tiltTransform,
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

    // 1. Boom (bottom layer)
    // Draw between projected mast and boom-end world positions
    const [bex, bey] = this.getBoomEndWorldPosition();
    const boomStartX = mx + boomOff.x;
    const boomStartY = my + boomOff.y;
    const boomEndX = bex + boomOff.x;
    const boomEndY = bey + boomOff.y;
    const boomAngle = Math.atan2(boomEndY - boomStartY, boomEndX - boomStartX);
    const boomLen = Math.hypot(boomEndX - boomStartX, boomEndY - boomStartY);

    draw.at({ pos: V(boomStartX, boomStartY), angle: boomAngle }, () => {
      draw.fillRect(0, -this.boomWidth / 2, boomLen, this.boomWidth, {
        color: this.boomColor,
      });
      draw.fillCircle(boomLen, 0, 0.3, { color: 0x664422 });
    });

    // 2. Standing rigging (above boom)
    const cr = t.cosRoll;
    const sr = t.sinRoll;
    const sp = t.sinPitch;
    const dz = this.stays.deckHeight;
    const riggingColor = 0x999999;
    const riggingWidth = 0.1;
    draw.at({ pos: V(hx, hy), angle: hullAngle }, () => {
      const lmx = this.mastPosition.x;
      const lmy = this.mastPosition.y;
      const topLX = lmx + mastTopLocal.x;
      const topLY = lmy + mastTopLocal.y;

      // Project stay attachment points to deck height
      const projectStay = (s: V2d) =>
        [s.x + dz * sp, s.y * cr + dz * sr] as const;

      const fs = projectStay(this.stays.forestay);
      const ps = projectStay(this.stays.portShroud);
      const ss = projectStay(this.stays.starboardShroud);
      const bs = projectStay(this.stays.backstay);

      draw.line(topLX, topLY, fs[0], fs[1], {
        color: riggingColor,
        width: riggingWidth,
      });
      draw.line(topLX, topLY, ps[0], ps[1], {
        color: riggingColor,
        width: riggingWidth,
      });
      draw.line(topLX, topLY, ss[0], ss[1], {
        color: riggingColor,
        width: riggingWidth,
      });
      draw.line(topLX, topLY, bs[0], bs[1], {
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
