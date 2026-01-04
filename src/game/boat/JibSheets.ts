import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import Body from "../../core/physics/body/Body";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import { lerp, stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Hull } from "./Hull";

// Hull-local attachment points for jib sheets
const PORT_SHEET_ATTACH = V(-5, 10);
const STARBOARD_SHEET_ATTACH = V(-5, -10);

// Sheet length limits
const SHEET_MIN_LENGTH = 8;
const SHEET_MAX_LENGTH = 40;
const SHEET_DEFAULT_LENGTH = 25;

// Adjustment speeds
const SHEET_PULL_SPEED = 20; // Units per second when trimming
const SHEET_EASE_SPEED = 60; // Faster release when SHIFT held

// Rendering
const SHEET_SAG_FACTOR = 1.5;

export class JibSheets extends BaseEntity {
  private sheetsSprite: GameSprite & Graphics;
  constraints: NonNullable<BaseEntity["constraints"]>;

  private portConstraint: DistanceConstraint;
  private starboardConstraint: DistanceConstraint;

  private portSheetPosition: number = 0.5; // 0 = full in, 1 = full out
  private starboardSheetPosition: number = 0.5;
  private portSheetLength: number = SHEET_DEFAULT_LENGTH;
  private starboardSheetLength: number = SHEET_DEFAULT_LENGTH;

  constructor(
    private hull: Hull,
    private clewBody: Body
  ) {
    super();

    this.sheetsSprite = createGraphics("main");
    this.sprite = this.sheetsSprite;

    // Create port sheet constraint (rope behavior)
    this.portConstraint = new DistanceConstraint(this.clewBody, this.hull.body, {
      localAnchorA: [0, 0],
      localAnchorB: [PORT_SHEET_ATTACH.x, PORT_SHEET_ATTACH.y],
    });
    this.portConstraint.lowerLimit = 0;
    this.portConstraint.lowerLimitEnabled = false;
    this.portConstraint.upperLimitEnabled = true;
    this.portConstraint.upperLimit = SHEET_DEFAULT_LENGTH;

    // Create starboard sheet constraint (rope behavior)
    this.starboardConstraint = new DistanceConstraint(
      this.clewBody,
      this.hull.body,
      {
        localAnchorA: [0, 0],
        localAnchorB: [STARBOARD_SHEET_ATTACH.x, STARBOARD_SHEET_ATTACH.y],
      }
    );
    this.starboardConstraint.lowerLimit = 0;
    this.starboardConstraint.lowerLimitEnabled = false;
    this.starboardConstraint.upperLimitEnabled = true;
    this.starboardConstraint.upperLimit = SHEET_DEFAULT_LENGTH;

    this.constraints = [this.portConstraint, this.starboardConstraint];
  }

  /**
   * Adjust port jib sheet length.
   * @param input -1 = pull in, 0 = hold, 1 = ease out
   * @param dt Delta time in seconds
   */
  adjustPortSheet(input: number, dt: number): void {
    if (input === 0) return;

    const target = input < 0 ? 0 : 1;
    const speed =
      input < 0
        ? SHEET_PULL_SPEED / (SHEET_MAX_LENGTH - SHEET_MIN_LENGTH)
        : SHEET_EASE_SPEED / (SHEET_MAX_LENGTH - SHEET_MIN_LENGTH);

    this.portSheetPosition = stepToward(
      this.portSheetPosition,
      target,
      speed * dt
    );
    this.portSheetLength = lerp(
      SHEET_MIN_LENGTH,
      SHEET_MAX_LENGTH,
      this.portSheetPosition
    );
    this.portConstraint.upperLimit = this.portSheetLength;
  }

  /**
   * Adjust starboard jib sheet length.
   * @param input -1 = pull in, 0 = hold, 1 = ease out
   * @param dt Delta time in seconds
   */
  adjustStarboardSheet(input: number, dt: number): void {
    if (input === 0) return;

    const target = input < 0 ? 0 : 1;
    const speed =
      input < 0
        ? SHEET_PULL_SPEED / (SHEET_MAX_LENGTH - SHEET_MIN_LENGTH)
        : SHEET_EASE_SPEED / (SHEET_MAX_LENGTH - SHEET_MIN_LENGTH);

    this.starboardSheetPosition = stepToward(
      this.starboardSheetPosition,
      target,
      speed * dt
    );
    this.starboardSheetLength = lerp(
      SHEET_MIN_LENGTH,
      SHEET_MAX_LENGTH,
      this.starboardSheetPosition
    );
    this.starboardConstraint.upperLimit = this.starboardSheetLength;
  }

  onRender() {
    const [hx, hy] = this.hull.body.position;
    const hullAngle = this.hull.body.angle;
    const clewWorld = V(this.clewBody.position);

    // Calculate hull attachment points in world space
    const portAttachWorld = PORT_SHEET_ATTACH.rotate(hullAngle).iadd([hx, hy]);
    const starboardAttachWorld = STARBOARD_SHEET_ATTACH.rotate(hullAngle).iadd([
      hx,
      hy,
    ]);

    this.sheetsSprite.clear();

    // Draw port sheet
    this.drawSheet(
      clewWorld,
      portAttachWorld,
      this.portSheetLength,
      V(hx, hy)
    );

    // Draw starboard sheet
    this.drawSheet(
      clewWorld,
      starboardAttachWorld,
      this.starboardSheetLength,
      V(hx, hy)
    );
  }

  private drawSheet(
    from: V2d,
    to: V2d,
    ropeLength: number,
    hullCenter: V2d
  ): void {
    const actualDistance = from.distanceTo(to);
    const slack = ropeLength - actualDistance;

    this.sheetsSprite.moveTo(from.x, from.y);

    if (slack > 0) {
      // Slack rope: draw bezier curve sagging toward hull center
      const midpoint = from.lerp(to, 0.5);
      const towardCenter = hullCenter.sub(midpoint).inormalize();
      const sagAmount = slack * SHEET_SAG_FACTOR;
      const controlPoint = midpoint.add(towardCenter.imul(sagAmount));

      this.sheetsSprite.quadraticCurveTo(
        controlPoint.x,
        controlPoint.y,
        to.x,
        to.y
      );
    } else {
      // Taut rope: draw straight line
      this.sheetsSprite.lineTo(to.x, to.y);
    }

    this.sheetsSprite.stroke({ color: 0x444444, width: 0.75 });
  }
}
