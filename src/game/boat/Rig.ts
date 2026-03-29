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
        getTiltTransform: () => this.hull.tiltTransform,
      }),
    );
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [hx, hy] = this.hull.body.position;
    const hullAngle = this.hull.body.angle;
    const [mx, my] = this.getMastWorldPosition();
    const t = this.hull.tiltTransform;
    const zOffset = this.hull.body.z;

    const mastTopWorld = t.worldOffset(20);

    // 1. Boom (bottom layer)
    // Boom has independent rotation from hull, so we keep manual 2D endpoint
    // computation but use t.worldZ() for the depth value.
    const relAngle = this.body.angle - this.hull.body.angle;
    const boomEndLocalX =
      this.mastPosition.x - this.boomLength * Math.cos(relAngle);
    const boomEndLocalY =
      this.mastPosition.y - this.boomLength * Math.sin(relAngle);
    const [boomStartX, boomStartY] = t.toWorld3D(
      this.mastPosition.x,
      this.mastPosition.y,
      this.boomZ,
    );
    const [boomEndX, boomEndY] = t.toWorld3D(
      boomEndLocalX,
      boomEndLocalY,
      this.boomZ,
    );
    const boomWorldZ = t.worldZ(
      this.mastPosition.x,
      this.mastPosition.y,
      this.boomZ,
      zOffset,
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

    // 2. Standing rigging (above boom)
    // Use GPU-driven tilt projection: draw.at with tilt context handles
    // parallax and depth. We draw with body-local coords and z = deckHeight.
    const dz = this.stays.deckHeight;
    const riggingColor = 0x999999;
    const riggingWidth = 0.1;
    draw.at(
      {
        pos: V(hx, hy),
        angle: hullAngle,
        tilt: {
          roll: this.hull.body.roll,
          pitch: this.hull.body.pitch,
          zOffset,
        },
      },
      () => {
        const lmx = this.mastPosition.x;
        const lmy = this.mastPosition.y;

        const fs = this.stays.forestay;
        const ps = this.stays.portShroud;
        const ss = this.stays.starboardShroud;
        const bs = this.stays.backstay;

        draw.line(lmx, lmy, fs.x, fs.y, {
          color: riggingColor,
          width: riggingWidth,
          z: dz,
        });
        draw.line(lmx, lmy, ps.x, ps.y, {
          color: riggingColor,
          width: riggingWidth,
          z: dz,
        });
        draw.line(lmx, lmy, ss.x, ss.y, {
          color: riggingColor,
          width: riggingWidth,
          z: dz,
        });
        draw.line(lmx, lmy, bs.x, bs.y, {
          color: riggingColor,
          width: riggingWidth,
          z: dz,
        });
      },
    );

    // 3. Mast (on top of everything)
    // Use t.worldZ() for depth at mast base and top.
    const mastBaseZ = t.worldZ(
      this.mastPosition.x,
      this.mastPosition.y,
      0,
      zOffset,
    );
    const mastTopZ = t.worldZ(
      this.mastPosition.x,
      this.mastPosition.y,
      20,
      zOffset,
    );
    draw.line(mx, my, mx + mastTopWorld.x, my + mastTopWorld.y, {
      color: this.mastColor,
      width: 0.4,
      z: mastTopZ,
    });
    draw.fillCircle(mx, my, 0.3, { color: this.mastColor, z: mastBaseZ });
    draw.fillCircle(mx + mastTopWorld.x, my + mastTopWorld.y, 0.2, {
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
