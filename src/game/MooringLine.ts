import { BaseEntity } from "../core/entity/BaseEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import { DistanceConstraint } from "../core/physics/constraints/DistanceConstraint";
import { stepToward } from "../core/util/MathUtil";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";
import { MooringPoint } from "./MooringPoint";
import { VerletRope } from "./rope/VerletRope";

type MooringState = "reeling" | "moored" | "releasing";

// Configuration
const MIN_MOORING_LENGTH = 3; // ft - how close to reel the boat in
const REEL_SPEED = 8; // ft/s - speed of reeling in
const RELEASE_SPEED = 15; // ft/s - speed of releasing (faster)
const ROPE_POINT_COUNT = 14;
const ROPE_THICKNESS = 0.35; // ft
const ROPE_COLOR = 0x886644; // Brown/tan rope

/**
 * A mooring line connecting a boat to a mooring point.
 * Automatically reels the boat in when created.
 */
export class MooringLine extends BaseEntity {
  layer = "underhull" as const;

  private constraint: DistanceConstraint;
  private visualRope: VerletRope;
  private state: MooringState = "reeling";

  // Rope length animation
  private currentLength: number;
  private targetLength: number;

  // Attachment positions
  private bowAttachPoint: V2d;

  constructor(
    private boat: Boat,
    private mooringPoint: MooringPoint,
  ) {
    super();

    // Get bow attachment point from boat config (same as anchor)
    this.bowAttachPoint = boat.config.anchor.bowAttachPoint;

    // Calculate initial rope length (current distance)
    const bowWorld = this.getBowWorldPosition();
    const mooringWorld = mooringPoint.getPosition();
    this.currentLength = bowWorld.sub(mooringWorld).magnitude;
    this.targetLength = MIN_MOORING_LENGTH;

    // Create distance constraint
    this.constraint = new DistanceConstraint(
      mooringPoint.body,
      boat.hull.body,
      {
        localAnchorA: [0, 0],
        localAnchorB: [this.bowAttachPoint.x, this.bowAttachPoint.y],
        collideConnected: false,
      },
    );
    this.constraint.lowerLimit = 0;
    this.constraint.lowerLimitEnabled = false;
    this.constraint.upperLimitEnabled = true;
    this.constraint.upperLimit = this.currentLength;

    // Add constraint to the constraints array for automatic physics integration
    this.constraints = [this.constraint];

    // Create visual rope
    this.visualRope = new VerletRope({
      pointCount: ROPE_POINT_COUNT,
      restLength: this.currentLength,
      gravity: V(0, 2.5),
      damping: 0.96,
      thickness: ROPE_THICKNESS,
      color: ROPE_COLOR,
    });

    // Initialize visual rope position
    this.visualRope.reset(mooringWorld, bowWorld);
  }

  /** Check if the mooring line is fully reeled in and secured */
  isMoored(): boolean {
    return this.state === "moored";
  }

  /** Check if the mooring line is in the process of releasing */
  isReleasing(): boolean {
    return this.state === "releasing";
  }

  /** Release the mooring line (will detach when rope is long enough) */
  release(): void {
    if (this.state === "releasing") return;
    this.state = "releasing";
    this.targetLength = this.currentLength + 10; // Release past current length
  }

  private getBowWorldPosition(): V2d {
    const [hx, hy] = this.boat.hull.body.position;
    return this.bowAttachPoint.rotate(this.boat.hull.body.angle).iadd([hx, hy]);
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    // Animate rope length toward target
    const speed = this.state === "releasing" ? RELEASE_SPEED : REEL_SPEED;
    const previousLength = this.currentLength;
    this.currentLength = stepToward(
      this.currentLength,
      this.targetLength,
      speed * dt,
    );

    // Update constraint if rope length changed
    if (this.currentLength !== previousLength) {
      this.constraint.upperLimit = Math.max(MIN_MOORING_LENGTH, this.currentLength);
      this.visualRope.setRestLength(this.currentLength);
    }

    // Check for state transitions
    if (this.state === "reeling" && this.currentLength <= MIN_MOORING_LENGTH) {
      this.state = "moored";
    } else if (this.state === "releasing" && this.currentLength >= this.targetLength) {
      // Fully released - destroy the mooring line
      this.game?.removeEntity(this);
      return;
    }

    // Update visual rope
    const bowWorld = this.getBowWorldPosition();
    const mooringWorld = this.mooringPoint.getPosition();
    this.visualRope.update(mooringWorld, bowWorld, dt);
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    this.visualRope.render(draw);
  }
}
