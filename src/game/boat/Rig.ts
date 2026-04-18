import { BaseEntity } from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
import { createRigid3D } from "../../core/physics/body/bodyFactories";
import { RevoluteConstraint3D } from "../../core/physics/constraints/RevoluteConstraint3D";
import { Box } from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import { RigConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import { Sail } from "./sail/Sail";

export class Rig extends BaseEntity {
  layer = "boat" as const;
  body: NonNullable<Entity["body"]>;
  private boomConstraint: RevoluteConstraint3D;
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

    // Boom physics body — 6DOF so the 3D revolute joint can lock its
    // orientation to the hull's (hinge around the mast axis). Pivot is at
    // origin, boom extends in -x direction.
    const [mastWorldX, mastWorldY, mastWorldZ] = hull.body.toWorldFrame3D(
      mastPosition.x,
      mastPosition.y,
      this.boomZ,
    );
    this.body = createRigid3D({
      motion: "dynamic",
      mass: boomMass,
      position: [mastWorldX, mastWorldY],
      rollInertia: 1,
      pitchInertia: 1,
      zMass: boomMass,
      z: mastWorldZ,
    });
    this.body.addShape(new Box({ width: boomLength, height: boomWidth }), [
      -boomLength / 2,
      0,
    ]);

    // 3D revolute joint (hinge around the mast axis): pins the boom to the
    // hull at the mast pivot in 3D and locks the boom's roll/pitch to the
    // hull's, leaving only yaw around the mast axis free.
    this.boomConstraint = new RevoluteConstraint3D(hull.body, this.body, {
      localPivotA: [mastPosition.x, mastPosition.y, this.boomZ],
      localPivotB: [0, 0, 0],
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

  /** Hull-local mast position. */
  getMastPosition(): V2d {
    return this.mastPosition;
  }

  /** Z-height of mast top. */
  getMastTopZ(): number {
    return this.mastTopZ;
  }

  /** Z-height of the boom. */
  getBoomZ(): number {
    return this.boomZ;
  }

  /** Boom width in ft. */
  getBoomWidth(): number {
    return this.boomWidth;
  }

  /** Mast visual color. */
  getMastColor(): number {
    return this.mastColor;
  }

  /** Boom visual color. */
  getBoomColor(): number {
    return this.boomColor;
  }

  /** Stay attachment config. */
  getStays(): typeof this.stays {
    return this.stays;
  }

  getMastWorldPosition(): V2d {
    const [x, y] = this.hull.body.position;
    return this.mastPosition.rotate(this.hull.body.angle).iadd([x, y]);
  }

  getBoomEndWorldPosition(): V2d {
    // Use the boom body's full 3D transform. The 3D revolute joint keeps
    // the boom body's orientation and z in sync with the hull's tilt, so
    // this naturally includes hull roll/pitch parallax.
    const [x, y] = this.body.toWorldFrame3D(-this.boomLength, 0, 0);
    return V(x, y);
  }

  getBoomLength(): number {
    return this.boomLength;
  }

  /**
   * Boom yaw relative to hull (around the hull's z-axis), maintained by
   * the 3D revolute joint via axis projection. Prefer this over
   * `boom.angle - hull.angle` — with hull tilt, that extraction mixes yaw
   * with tilt due to atan2 projection.
   */
  getBoomRelativeYaw(): number {
    return this.boomConstraint.getRelativeAngle();
  }
}
