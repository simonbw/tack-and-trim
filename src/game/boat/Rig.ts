import { BaseEntity } from "../../core/entity/BaseEntity";
import Entity from "../../core/entity/Entity";
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
    const [mx, my] = this.getMastWorldPosition();
    return V(-this.boomLength, 0).rotate(this.body.angle).iadd([mx, my]);
  }

  getBoomLength(): number {
    return this.boomLength;
  }
}
