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
  layer = "boat" as const;
  body: NonNullable<Entity["body"]>;
  private boomConstraint: RevoluteConstraint;
  sail!: Sail;

  private mastPosition: V2d;
  private boomLength: number;
  private boomWidth: number;
  private boomZ: number;
  private mastColor: number;
  private boomColor: number;
  private mastTopZ: number;
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
    this.boomZ = mainsail.zFoot ?? 3;
    this.mastTopZ = mainsail.zHead ?? 20;
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

    // Constraint connecting boom to hull at mast position.
    // localPivotZA sets the z-height so constraint reactions automatically
    // generate roll/pitch torques via 3D cross products in the solver.
    this.boomConstraint = new RevoluteConstraint(hull.body, this.body, {
      localPivotA: [mastPosition.x, mastPosition.y],
      localPivotB: [0, 0],
      localPivotZA: this.boomZ,
      collideConnected: false,
    });

    this.constraints = [this.boomConstraint];

    // Create mainsail
    this.sail = this.addChild(
      new Sail({
        ...mainsail,
        getHeadPosition: () => this.getMastWorldPosition(),
        headLocalPosition: mastPosition,
        getClewPosition: () => this.getBoomEndWorldPosition(),
        headConstraint: { body: this.body, localAnchor: V(0, 0) },
        clewConstraint: { body: this.body, localAnchor: V(-boomLength, 0) },
        getHullBody: () => this.hull.body,
      }),
    );
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [hx, hy] = this.hull.body.position;
    const hullAngle = this.hull.body.angle;
    const [mx, my] = this.getMastWorldPosition();
    const hullBody = this.hull.body;
    const zOffset = hullBody.z;

    const mastTopOffsetX = hullBody.zParallaxX(this.mastTopZ);
    const mastTopOffsetY = hullBody.zParallaxY(this.mastTopZ);

    // 1. Boom (bottom layer)
    // Boom has independent rotation from hull, so we keep manual 2D endpoint
    // computation but use body.worldZ() for the depth value.
    const relAngle = this.body.angle - hullBody.angle;
    const boomEndLocalX =
      this.mastPosition.x - this.boomLength * Math.cos(relAngle);
    const boomEndLocalY =
      this.mastPosition.y - this.boomLength * Math.sin(relAngle);
    const [boomStartX, boomStartY] = hullBody.toWorldFrame3D(
      this.mastPosition.x,
      this.mastPosition.y,
      this.boomZ,
    );
    const [boomEndX, boomEndY] = hullBody.toWorldFrame3D(
      boomEndLocalX,
      boomEndLocalY,
      this.boomZ,
    );
    const boomWorldZ = hullBody.worldZ(
      this.mastPosition.x,
      this.mastPosition.y,
      this.boomZ,
    );
    const boomAngle = Math.atan2(boomEndY - boomStartY, boomEndX - boomStartX);
    const boomLen = Math.hypot(boomEndX - boomStartX, boomEndY - boomStartY);

    draw.at({ pos: V(boomStartX, boomStartY), angle: boomAngle }, () => {
      draw.fillRect(0, -this.boomWidth / 2, boomLen, this.boomWidth, {
        color: this.boomColor,
        z: boomWorldZ,
      });
      draw.fillCircle(boomLen, 0, 0.3, { color: 0x664422, z: boomWorldZ });
    });

    // 2. Standing rigging — lines from masthead to deck attachment points.
    // World-space rendering so each endpoint gets correct z-parallax.
    const mastTopX = mx + mastTopOffsetX;
    const mastTopY = my + mastTopOffsetY;
    const mastTopWorldZ = hullBody.worldZ(
      this.mastPosition.x,
      this.mastPosition.y,
      this.mastTopZ,
    );
    const riggingColor = 0x999999;
    const riggingWidth = 0.1;
    const dz = this.stays.deckHeight;
    const stayAttachments = [
      this.stays.forestay,
      this.stays.portShroud,
      this.stays.starboardShroud,
      this.stays.backstay,
    ];
    for (const attach of stayAttachments) {
      const [ax, ay] = hullBody.toWorldFrame3D(attach.x, attach.y, dz);
      draw.line(mastTopX, mastTopY, ax, ay, {
        color: riggingColor,
        width: riggingWidth,
        z: mastTopWorldZ,
      });
    }

    // 3. Mast (on top of everything)
    // Use body.worldZ() for depth at mast base and top.
    const mastBaseZ = hullBody.worldZ(
      this.mastPosition.x,
      this.mastPosition.y,
      0,
    );
    const mastTopZ = mastTopWorldZ;
    draw.line(mx, my, mx + mastTopOffsetX, my + mastTopOffsetY, {
      color: this.mastColor,
      width: 0.4,
      z: mastTopZ,
    });
    draw.fillCircle(mx, my, 0.3, { color: this.mastColor, z: mastBaseZ });
    draw.fillCircle(mx + mastTopOffsetX, my + mastTopOffsetY, 0.2, {
      color: this.mastColor,
      z: mastTopZ,
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
