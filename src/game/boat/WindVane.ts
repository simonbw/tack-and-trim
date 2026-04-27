import { BaseEntity } from "../../core/entity/BaseEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { WindQuery } from "../world/wind/WindQuery";
import { Hull } from "./Hull";
import { Rig } from "./Rig";
import { computeTiltProjection } from "./tessellation";
import { TiltDraw } from "./TiltDraw";

/**
 * Masthead wind indicator. Reads apparent wind at the top of the mast and
 * weather-vanes into it: the arrow tip points TOWARD the wind source, the
 * tail trails downwind. Modelled as a damped angular oscillator whose
 * stiffness scales with v² (dynamic pressure) and damping with v, so the
 * vane is sluggish in light air and snappy in a breeze.
 */
export class WindVane extends BaseEntity {
  layer = "boat" as const;

  private hull: Hull;
  private rig: Rig;

  private vaneAngle: number;
  private vaneAngularVelocity = 0;

  private windQuery = this.addChild(
    new WindQuery(() => [
      this.hull.body.toWorldFrame(this.rig.getMastPosition()),
    ]),
  );

  // Geometry (feet, hull-local layout around the mast)
  private readonly zOffset = 0.6;
  private readonly arrowLength = 1.6;
  private readonly tailLength = 1.2;
  private readonly shaftWidth = 0.06;
  private readonly arrowheadLength = 0.32;
  private readonly arrowheadHalfWidth = 0.13;
  private readonly tailHalfWidth = 0.22;

  // Dynamics tuning. Treats moment of inertia as 1; k and c subsume it.
  private readonly stiffness = 6.0;
  private readonly damping = 4.0;

  constructor(rig: Rig) {
    super();
    this.rig = rig;
    this.hull = rig.hull;
    this.vaneAngle = this.hull.body.angle;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    // Query results take a frame to arrive; skip the dynamics update until
    // they do. Reading .velocity before then dereferences an empty buffer.
    const hasWind = this.windQuery.length > 0;
    const speed = hasWind ? this.updateApparentWind() : 0;

    if (speed > 0.01) {
      // Arrow tip points toward the wind source — opposite of velocity.
      const target = Math.atan2(-this.apparentY, -this.apparentX);
      let err = target - this.vaneAngle;
      err = Math.atan2(Math.sin(err), Math.cos(err));

      const torque =
        this.stiffness * err * speed * speed -
        this.damping * this.vaneAngularVelocity * speed;
      this.vaneAngularVelocity += torque * dt;
    }
    this.vaneAngle += this.vaneAngularVelocity * dt;
  }

  private apparentX = 0;
  private apparentY = 0;

  private updateApparentWind(): number {
    const trueWind = this.windQuery.get(0).velocity;
    const mastheadVel = this.hull.body.getVelocityAtPoint(
      this.rig.getMastPosition(),
    );
    this.apparentX = trueWind.x - mastheadVel.x;
    this.apparentY = trueWind.y - mastheadVel.y;
    return Math.hypot(this.apparentX, this.apparentY);
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const body = this.hull.body;
    const tilt = computeTiltProjection(body.angle, body.roll, body.pitch);

    draw.at(
      {
        pos: body.position,
        angle: body.angle,
        tilt: { roll: body.roll, pitch: body.pitch, zOffset: body.z },
      },
      () => {
        const td = new TiltDraw(draw.renderer, tilt);
        const mast = this.rig.getMastPosition();
        const z = this.rig.getMastTopZ() + this.zOffset;

        // Vane angle is tracked in world frame; the surrounding draw.at
        // rotates by hull yaw, so undo that to get hull-local direction.
        const a = this.vaneAngle - body.angle;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const px = -sin;
        const py = cos;

        const tipX = mast.x + this.arrowLength * cos;
        const tipY = mast.y + this.arrowLength * sin;
        const tailX = mast.x - this.tailLength * cos;
        const tailY = mast.y - this.tailLength * sin;
        const headBaseX = tipX - this.arrowheadLength * cos;
        const headBaseY = tipY - this.arrowheadLength * sin;

        const color = 0x000000;

        td.line(
          tailX,
          tailY,
          z,
          tipX,
          tipY,
          z,
          this.shaftWidth,
          color,
          1,
          true,
        );

        td.mesh({
          positions: [
            [tipX, tipY],
            [
              headBaseX + px * this.arrowheadHalfWidth,
              headBaseY + py * this.arrowheadHalfWidth,
            ],
            [
              headBaseX - px * this.arrowheadHalfWidth,
              headBaseY - py * this.arrowheadHalfWidth,
            ],
          ],
          zValues: [z, z, z],
          indices: [0, 1, 2],
          color,
          alpha: 1,
        });

        // Tail triangle, apex pointing the same way as the arrowhead — base
        // at the back, point toward the mast pivot — so the whole vane reads
        // as a single direction at a glance.
        td.mesh({
          positions: [
            [mast.x, mast.y],
            [tailX + px * this.tailHalfWidth, tailY + py * this.tailHalfWidth],
            [tailX - px * this.tailHalfWidth, tailY - py * this.tailHalfWidth],
          ],
          zValues: [z, z, z],
          indices: [0, 1, 2],
          color,
          alpha: 1,
        });

        td.flatCircle(mast.x, mast.y, z, 0.08, 12, color);
      },
    );
  }
}
