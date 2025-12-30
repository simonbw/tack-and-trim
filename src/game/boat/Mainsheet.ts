import { DistanceConstraint } from "../../core/p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { lerp, stepToward } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { Hull } from "./Hull";
import { Rig } from "./Rig";

const MAINSHEET_BOOM_ATTACH_RATIO = 0.9; // attach near end of boom
const MAINSHEET_HULL_ATTACH = V(-12, 0); // cockpit area on hull
const MAINSHEET_MIN_LENGTH = 6; // Fully sheeted in
const MAINSHEET_MAX_LENGTH = 35; // Fully eased out
const MAINSHEET_DEFAULT_LENGTH = 20; // Starting position
const MAINSHEET_ADJUST_SPEED = 15; // Units per second
const MAINSHEET_SAG_FACTOR = 1.5; // How much the rope sags per unit of slack

export class Mainsheet extends BaseEntity {
  private mainsheetSprite: GameSprite & Graphics;
  private constraint: DistanceConstraint;
  private boomAttachLocal: ReturnType<typeof V>;
  private sheetPosition: number = 0.5; // 0 = full in, 1 = full out
  private ropeLength: number = MAINSHEET_DEFAULT_LENGTH;

  constructor(
    private hull: Hull,
    private rig: Rig
  ) {
    super();

    this.mainsheetSprite = createGraphics("main");
    this.sprite = this.mainsheetSprite;

    // Calculate boom attach point from rig's boom length
    this.boomAttachLocal = V(
      -this.rig.getBoomLength() * MAINSHEET_BOOM_ATTACH_RATIO,
      0
    );

    // Create distance constraint configured as a rope:
    // - upperLimitEnabled: true (can't stretch beyond length)
    // - lowerLimitEnabled: false (can be slack/closer)
    this.constraint = new DistanceConstraint(this.rig.body, this.hull.body, {
      localAnchorA: [this.boomAttachLocal.x, this.boomAttachLocal.y],
      localAnchorB: [MAINSHEET_HULL_ATTACH.x, MAINSHEET_HULL_ATTACH.y],
    });

    // Configure as rope: only enforce upper limit (no stretching)
    this.constraint.lowerLimit = 0;
    this.constraint.lowerLimitEnabled = false;
    this.constraint.upperLimitEnabled = true;
    this.constraint.upperLimit = MAINSHEET_DEFAULT_LENGTH;

    this.constraints = [this.constraint];
  }

  /**
   * Adjust mainsheet length based on player input.
   * @param input -1 to 1 where negative = sheet in (shorter), positive = ease out (longer)
   * @param dt Delta time in seconds
   */
  setSheet(input: number, dt: number): void {
    if (input === 0) return; // No input, hold current position

    // Calculate target: input < 0 means sheet in (toward 0), input > 0 means ease out (toward 1)
    const target = input < 0 ? 0 : 1;

    // Smoothly adjust sheet position
    const speed =
      (Math.abs(input) * MAINSHEET_ADJUST_SPEED) /
      (MAINSHEET_MAX_LENGTH - MAINSHEET_MIN_LENGTH);
    this.sheetPosition = stepToward(this.sheetPosition, target, speed * dt);

    // Update rope length and constraint upper limit
    this.ropeLength = lerp(
      MAINSHEET_MIN_LENGTH,
      MAINSHEET_MAX_LENGTH,
      this.sheetPosition
    );
    this.constraint.upperLimit = this.ropeLength;
  }

  onRender() {
    const [x, y] = this.hull.body.position;
    const [mx, my] = this.rig.getMastWorldPosition();

    const boomAttachWorld = this.boomAttachLocal
      .rotate(this.rig.body.angle)
      .iadd([mx, my]);
    const hullAttachWorld = MAINSHEET_HULL_ATTACH.rotate(
      this.hull.body.angle
    ).iadd([x, y]);

    // Calculate slack: positive when rope is loose
    const actualDistance = boomAttachWorld.sub(hullAttachWorld).magnitude;
    const slack = this.ropeLength - actualDistance;

    this.mainsheetSprite.clear();
    this.mainsheetSprite.moveTo(boomAttachWorld.x, boomAttachWorld.y);

    if (slack > 0) {
      // Slack rope: draw bezier curve sagging toward hull center
      const midpoint = boomAttachWorld.add(hullAttachWorld).imul(0.5);
      const hullCenter = V(x, y);
      const towardCenter = hullCenter.sub(midpoint).inormalize();
      const sagAmount = slack * MAINSHEET_SAG_FACTOR;
      const controlPoint = midpoint.add(towardCenter.imul(sagAmount));

      this.mainsheetSprite.quadraticCurveTo(
        controlPoint.x,
        controlPoint.y,
        hullAttachWorld.x,
        hullAttachWorld.y
      );
    } else {
      // Taut rope: draw straight line
      this.mainsheetSprite.lineTo(hullAttachWorld.x, hullAttachWorld.y);
    }

    this.mainsheetSprite.stroke({ color: 0x444444, width: 0.75 });
  }
}
