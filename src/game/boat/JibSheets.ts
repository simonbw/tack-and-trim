import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import Body from "../../core/physics/body/Body";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import { lerp, stepToward } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { VerletRope } from "../rope/VerletRope";
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

export class JibSheets extends BaseEntity {
  private sheetsSprite: GameSprite & Graphics;
  constraints: NonNullable<BaseEntity["constraints"]>;

  private portConstraint: DistanceConstraint;
  private starboardConstraint: DistanceConstraint;

  private portSheetPosition: number = 0.5; // 0 = full in, 1 = full out
  private starboardSheetPosition: number = 0.5;
  private portSheetLength: number = SHEET_DEFAULT_LENGTH;
  private starboardSheetLength: number = SHEET_DEFAULT_LENGTH;

  private portRope: VerletRope;
  private starboardRope: VerletRope;

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

    const ropeConfig = {
      pointCount: 8,
      restLength: SHEET_DEFAULT_LENGTH,
      gravity: V(0, 3),
      damping: 0.98,
      thickness: 0.75,
      color: 0x444444,
    };
    this.portRope = new VerletRope(ropeConfig);
    this.starboardRope = new VerletRope({ ...ropeConfig });
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
    this.portRope.setRestLength(this.portSheetLength);
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
    this.starboardRope.setRestLength(this.starboardSheetLength);
  }

  private getPortAttachWorld() {
    const [hx, hy] = this.hull.body.position;
    return PORT_SHEET_ATTACH.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  private getStarboardAttachWorld() {
    const [hx, hy] = this.hull.body.position;
    return STARBOARD_SHEET_ATTACH.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  onTick(dt: number): void {
    const clewWorld = V(this.clewBody.position);
    const portAttach = this.getPortAttachWorld();
    const starboardAttach = this.getStarboardAttachWorld();

    this.portRope.update(clewWorld, portAttach, dt);
    this.starboardRope.update(clewWorld, starboardAttach, dt);
  }

  onRender() {
    this.sheetsSprite.clear();
    this.portRope.render(this.sheetsSprite);
    this.starboardRope.render(this.sheetsSprite);
  }
}
