import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { VerletRope } from "../rope/VerletRope";
import { Hull } from "./Hull";

// Configuration
const BOW_ATTACH_POINT = V(26, 0); // Near bow (hull-local), matches JIB_TACK_POSITION
const MAX_RODE_LENGTH = 100; // Maximum rope length
const ANCHOR_SIZE = 3; // Visual size of anchor

// Animation speeds
const RODE_DEPLOY_SPEED = 40; // Units per second when dropping anchor
const RODE_RETRIEVE_SPEED = 20; // Units per second when raising anchor (slower - winching)

// Anchor physics - holding power scales with scope (rope out / max rope)
const ANCHOR_MASS = 50; // Base mass of anchor
const ANCHOR_DRAG_COEFFICIENT = 200; // Drag force per unit velocity at full scope

type AnchorState = "stowed" | "deploying" | "deployed" | "retrieving";

export class Anchor extends BaseEntity {
  private anchorSprite: GameSprite & Graphics;
  private rodeSprite: GameSprite & Graphics;

  private anchorBody: DynamicBody | null = null;
  private rodeConstraint: DistanceConstraint | null = null;
  private state: AnchorState = "stowed";
  private anchorPosition: V2d = V(0, 0);

  // Rope length animation
  private currentRodeLength: number = 0;
  private targetRodeLength: number = 0;

  private visualRope: VerletRope;

  constructor(private hull: Hull) {
    super();

    this.anchorSprite = createGraphics("underhull");
    this.rodeSprite = createGraphics("underhull");
    this.sprites = [this.rodeSprite, this.anchorSprite];

    this.visualRope = new VerletRope({
      pointCount: 12,
      restLength: MAX_RODE_LENGTH,
      gravity: V(0, 5), // Gentle gravity (underwater drag)
      damping: 0.95, // Heavy damping for anchor rode
      thickness: 1.5,
      color: 0x666644,
    });
  }

  /** Check if anchor is deployed or in the process of deploying */
  isDeployed(): boolean {
    return this.state === "deployed" || this.state === "deploying";
  }

  /** Get current anchor state */
  getState(): AnchorState {
    return this.state;
  }

  /** Start deploying the anchor */
  deploy(): void {
    if (this.state !== "stowed" || !this.game) return;

    // Get world position for anchor drop at bow
    this.anchorPosition = this.getBowWorldPosition();

    // Create dynamic body at anchor position with high mass
    this.anchorBody = new DynamicBody({
      mass: ANCHOR_MASS,
      position: [this.anchorPosition.x, this.anchorPosition.y],
      damping: 0.5, // Some base damping
      fixedRotation: true,
      allowSleep: false, // Keep anchor awake for drag calculations
    });
    this.anchorBody.addShape(new Particle());

    // Add to physics world
    this.game.world.bodies.add(this.anchorBody);

    // Create rope constraint (only upper limit - can't stretch beyond length)
    this.rodeConstraint = new DistanceConstraint(
      this.anchorBody,
      this.hull.body,
      {
        localAnchorA: [0, 0],
        localAnchorB: [BOW_ATTACH_POINT.x, BOW_ATTACH_POINT.y],
        collideConnected: false, // Don't collide with anchor
      }
    );
    this.rodeConstraint.lowerLimit = 0;
    this.rodeConstraint.lowerLimitEnabled = false;
    this.rodeConstraint.upperLimitEnabled = true;
    // Start with minimal rope - will animate outward
    this.currentRodeLength = 1;
    this.targetRodeLength = MAX_RODE_LENGTH;
    this.rodeConstraint.upperLimit = this.currentRodeLength;

    // Add constraint to physics world
    this.game.world.constraints.add(this.rodeConstraint);

    // Initialize visual rope
    const bowWorld = this.getBowWorldPosition();
    this.visualRope.reset(this.anchorPosition, bowWorld);
    this.visualRope.setRestLength(this.currentRodeLength);

    this.state = "deploying";
  }

  /** Start retrieving the anchor */
  retrieve(): void {
    if (this.state !== "deployed" && this.state !== "deploying") return;
    if (!this.game) return;

    // Set target to 0 - will animate inward and clean up when done
    this.targetRodeLength = 0;
    this.state = "retrieving";
  }

  /** Complete the retrieval - remove physics objects */
  private completeRetrieval(): void {
    if (!this.game) return;

    // Remove from physics world
    if (this.rodeConstraint) {
      this.game.world.constraints.remove(this.rodeConstraint);
      this.rodeConstraint = null;
    }
    if (this.anchorBody) {
      this.game.world.bodies.remove(this.anchorBody);
      this.anchorBody = null;
    }

    this.state = "stowed";
    this.currentRodeLength = 0;
  }

  toggle(): void {
    if (this.state === "stowed") {
      this.deploy();
    } else if (this.state === "deployed" || this.state === "deploying") {
      this.retrieve();
    }
    // If retrieving, ignore toggle (let it finish)
  }

  private getBowWorldPosition(): V2d {
    const [hx, hy] = this.hull.body.position;
    return BOW_ATTACH_POINT.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  onTick(dt: number): void {
    if (this.state === "stowed") return;

    // Animate rope length toward target
    const speed =
      this.state === "retrieving" ? RODE_RETRIEVE_SPEED : RODE_DEPLOY_SPEED;
    const previousLength = this.currentRodeLength;
    this.currentRodeLength = stepToward(
      this.currentRodeLength,
      this.targetRodeLength,
      speed * dt
    );

    // Update constraint if rope length changed
    if (
      this.rodeConstraint &&
      this.currentRodeLength !== previousLength
    ) {
      this.rodeConstraint.upperLimit = Math.max(1, this.currentRodeLength);
      this.visualRope.setRestLength(this.currentRodeLength);
    }

    // Check for state transitions
    if (this.state === "deploying" && this.currentRodeLength >= MAX_RODE_LENGTH) {
      this.state = "deployed";
    } else if (this.state === "retrieving" && this.currentRodeLength <= 1) {
      this.completeRetrieval();
      return;
    }

    // Apply scope-based drag force to anchor
    // Scope = how much rope is out relative to max (0-1)
    // More scope = more holding power (simulates chain weight on bottom)
    if (this.anchorBody) {
      const scope = this.currentRodeLength / MAX_RODE_LENGTH;
      const velocity = this.anchorBody.velocity;
      const speed = velocity.magnitude;

      if (speed > 0.01) {
        // Drag force opposing velocity, scaled by scope
        const dragMagnitude = ANCHOR_DRAG_COEFFICIENT * scope * speed;
        const dragForce = velocity.normalize().imul(-dragMagnitude);
        this.anchorBody.applyForce(dragForce);
      }

      // Update anchor position for rendering
      this.anchorPosition = V(this.anchorBody.position);
    }

    // Update visual rope
    const bowWorld = this.getBowWorldPosition();
    this.visualRope.update(this.anchorPosition, bowWorld, dt);
  }

  onRender(): void {
    this.anchorSprite.clear();
    this.rodeSprite.clear();

    if (this.state === "stowed") return;

    // Draw anchor
    this.drawAnchor(this.anchorPosition);

    // Draw rode using visual rope simulation
    this.visualRope.render(this.rodeSprite);
  }

  private drawAnchor(pos: V2d): void {
    // Simple anchor shape
    this.anchorSprite
      .circle(pos.x, pos.y, ANCHOR_SIZE)
      .fill({ color: 0x444444 })
      .stroke({ color: 0x333333, width: 1 });
  }

  onDestroy(): void {
    // Clean up physics objects directly (bypass animation)
    if (this.game) {
      if (this.rodeConstraint) {
        this.game.world.constraints.remove(this.rodeConstraint);
      }
      if (this.anchorBody) {
        this.game.world.bodies.remove(this.anchorBody);
      }
    }
  }
}
