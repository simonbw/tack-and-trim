import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import StaticBody from "../../core/physics/body/StaticBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { V, V2d } from "../../core/Vector";
import { VerletRope } from "../rope/VerletRope";
import { Hull } from "./Hull";

// Configuration
const BOW_ATTACH_POINT = V(26, 0); // Near bow (hull-local), matches JIB_TACK_POSITION
const ANCHOR_RODE_LENGTH = 100; // Maximum rope length
const ANCHOR_SIZE = 3; // Visual size of anchor

export class Anchor extends BaseEntity {
  private anchorSprite: GameSprite & Graphics;
  private rodeSprite: GameSprite & Graphics;

  private anchorBody: StaticBody | null = null;
  private rodeConstraint: DistanceConstraint | null = null;
  private deployed: boolean = false;
  private anchorPosition: V2d = V(0, 0);

  private visualRope: VerletRope;

  constructor(private hull: Hull) {
    super();

    this.anchorSprite = createGraphics("underhull");
    this.rodeSprite = createGraphics("underhull");
    this.sprites = [this.rodeSprite, this.anchorSprite];

    this.visualRope = new VerletRope({
      pointCount: 12,
      restLength: ANCHOR_RODE_LENGTH,
      gravity: V(0, 5), // Gentle gravity (underwater drag)
      damping: 0.95, // Heavy damping for anchor rode
      thickness: 1.5,
      color: 0x666644,
    });
  }

  isDeployed(): boolean {
    return this.deployed;
  }

  deploy(): void {
    if (this.deployed || !this.game) return;

    // Get world position for anchor drop at bow
    this.anchorPosition = this.getBowWorldPosition();

    // Create static body at anchor position
    this.anchorBody = new StaticBody({
      position: [this.anchorPosition.x, this.anchorPosition.y],
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
    this.rodeConstraint.upperLimit = ANCHOR_RODE_LENGTH;

    // Add constraint to physics world
    this.game.world.constraints.add(this.rodeConstraint);

    // Initialize visual rope
    const bowWorld = this.getBowWorldPosition();
    this.visualRope.reset(this.anchorPosition, bowWorld);

    this.deployed = true;
  }

  retrieve(): void {
    if (!this.deployed || !this.game) return;

    // Remove from physics world
    if (this.rodeConstraint) {
      this.game.world.constraints.remove(this.rodeConstraint);
      this.rodeConstraint = null;
    }
    if (this.anchorBody) {
      this.game.world.bodies.remove(this.anchorBody);
      this.anchorBody = null;
    }

    this.deployed = false;
  }

  toggle(): void {
    if (this.deployed) {
      this.retrieve();
    } else {
      this.deploy();
    }
  }

  private getBowWorldPosition(): V2d {
    const [hx, hy] = this.hull.body.position;
    return BOW_ATTACH_POINT.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  onTick(dt: number): void {
    if (!this.deployed) return;

    const bowWorld = this.getBowWorldPosition();
    this.visualRope.update(this.anchorPosition, bowWorld, dt);
  }

  onRender(): void {
    this.anchorSprite.clear();
    this.rodeSprite.clear();

    if (!this.deployed) return;

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
    this.retrieve(); // Clean up physics objects
  }
}
