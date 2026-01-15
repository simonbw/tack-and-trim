import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { stepToward } from "../../core/util/MathUtil";
import { rDirection, rUniform } from "../../core/util/Random";
import { V, V2d } from "../../core/Vector";
import { VerletRope } from "../rope/VerletRope";
import { SprayParticle } from "../SprayParticle";
import { AnchorSplashRipple } from "../water/AnchorSplashRipple";
import { AnchorConfig } from "./BoatConfig";
import { Hull } from "./Hull";

type AnchorState = "stowed" | "deploying" | "deployed" | "retrieving";

// Splash effect configuration
const SPLASH_SPRAY_COUNT = 128;
const SPLASH_SPRAY_MIN_SIZE = 0.06; // ft
const SPLASH_SPRAY_MAX_SIZE = 0.2; // ft
const SPLASH_SPRAY_MIN_H_SPEED = 3; // ft/s
const SPLASH_SPRAY_MAX_H_SPEED = 30; // ft/s
const SPLASH_SPRAY_MIN_Z_VELOCITY = 2; // ft/s
const SPLASH_SPRAY_MAX_Z_VELOCITY = 60; // ft/s

const RODE_RETRIEVAL_THRESHOLD = 0.1; // ft

export class Anchor extends BaseEntity {
  layer = "underhull" as const;

  private anchorBody: DynamicBody | null = null;
  private rodeConstraint: DistanceConstraint | null = null;
  private state: AnchorState = "stowed";
  private anchorPosition: V2d = V(0, 0);

  // Rope length animation
  private currentRodeLength: number = 0;
  private targetRodeLength: number = 0;

  private visualRope: VerletRope;

  // Config values
  private bowAttachPoint: V2d;
  private maxRodeLength: number;
  private anchorSize: number;
  private rodeDeploySpeed: number;
  private rodeRetrieveSpeed: number;
  private anchorMass: number;
  private anchorDragCoefficient: number;

  constructor(
    private hull: Hull,
    config: AnchorConfig,
  ) {
    super();

    this.bowAttachPoint = config.bowAttachPoint;
    this.maxRodeLength = config.maxRodeLength;
    this.anchorSize = config.anchorSize;
    this.rodeDeploySpeed = config.rodeDeploySpeed;
    this.rodeRetrieveSpeed = config.rodeRetrieveSpeed;
    this.anchorMass = config.anchorMass;
    this.anchorDragCoefficient = config.anchorDragCoefficient;

    this.visualRope = new VerletRope({
      pointCount: 12,
      restLength: config.maxRodeLength,
      gravity: V(0, 2), // Gentle gravity (underwater drag, ft/s²)
      damping: 0.95, // Heavy damping for anchor rode
      thickness: 0.3, // Rope thickness in ft (~4 inches)
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
      mass: this.anchorMass,
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
        localAnchorB: [this.bowAttachPoint.x, this.bowAttachPoint.y],
        collideConnected: false, // Don't collide with anchor
      },
    );
    this.rodeConstraint.lowerLimit = 0;
    this.rodeConstraint.lowerLimitEnabled = false;
    this.rodeConstraint.upperLimitEnabled = true;
    // Start with minimal rope - will animate outward
    this.currentRodeLength = 1;
    this.targetRodeLength = this.maxRodeLength;
    this.rodeConstraint.upperLimit = this.currentRodeLength;

    // Add constraint to physics world
    this.game.world.constraints.add(this.rodeConstraint);

    // Initialize visual rope
    const bowWorld = this.getBowWorldPosition();
    this.visualRope.reset(this.anchorPosition, bowWorld);
    this.visualRope.setRestLength(this.currentRodeLength);

    this.state = "deploying";

    // Spawn splash effects
    this.spawnSplashEffects();
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
    return this.bowAttachPoint.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  /** Spawn ripple and spray particles at anchor position */
  private spawnSplashEffects(): void {
    if (!this.game) return;

    // Spawn ripple effect
    this.game.addEntity(new AnchorSplashRipple(this.anchorPosition.clone()));

    // Spawn spray particles radiating outward
    for (let i = 0; i < SPLASH_SPRAY_COUNT; i++) {
      const angle = rDirection();
      const hSpeed = rUniform(
        SPLASH_SPRAY_MIN_H_SPEED,
        SPLASH_SPRAY_MAX_H_SPEED,
      );
      const velocity = V2d.fromPolar(hSpeed, angle);
      const zVelocity = rUniform(
        SPLASH_SPRAY_MIN_Z_VELOCITY,
        SPLASH_SPRAY_MAX_Z_VELOCITY,
      );
      const size = rUniform(SPLASH_SPRAY_MIN_SIZE, SPLASH_SPRAY_MAX_SIZE);

      // Slight position offset for natural spread
      const offset = V2d.fromPolar(rUniform(0, 0.5), angle);
      const spawnPos = this.anchorPosition.add(offset);

      this.game.addEntity(
        new SprayParticle(spawnPos, velocity, zVelocity, size),
      );
    }
  }

  @on("tick")
  onTick(dt: number): void {
    if (this.state === "stowed") return;

    // Animate rope length toward target
    const speed =
      this.state === "retrieving"
        ? this.rodeRetrieveSpeed
        : this.rodeDeploySpeed;
    const previousLength = this.currentRodeLength;
    this.currentRodeLength = stepToward(
      this.currentRodeLength,
      this.targetRodeLength,
      speed * dt,
    );

    // Update constraint if rope length changed
    if (this.rodeConstraint && this.currentRodeLength !== previousLength) {
      this.rodeConstraint.upperLimit = Math.max(1, this.currentRodeLength);
      this.visualRope.setRestLength(this.currentRodeLength);
    }

    // Check for state transitions
    if (
      this.state === "deploying" &&
      this.currentRodeLength >= this.maxRodeLength
    ) {
      this.state = "deployed";
    } else if (
      this.state === "retrieving" &&
      this.currentRodeLength <= RODE_RETRIEVAL_THRESHOLD
    ) {
      this.completeRetrieval();
      return;
    }

    // Apply scope-based drag force to anchor
    // Scope = how much rope is out relative to max (0-1)
    // More scope = more holding power (simulates chain weight on bottom)
    if (this.anchorBody) {
      const scope = this.currentRodeLength / this.maxRodeLength;
      const velocity = this.anchorBody.velocity;
      const speed = velocity.magnitude;

      if (speed > 0.01) {
        // Drag force opposing velocity, scaled by scope
        const dragMagnitude = this.anchorDragCoefficient * scope * speed;
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

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }): void {
    if (this.state === "stowed") {
      // Draw stowed anchor at bow
      const bowPos = this.getBowWorldPosition();
      draw.fillCircle(bowPos.x, bowPos.y, this.anchorSize, {
        color: 0x444444,
      });
      return;
    }

    // Draw rode using visual rope simulation
    this.visualRope.render(draw);

    // Draw anchor (simple circle)
    draw.fillCircle(
      this.anchorPosition.x,
      this.anchorPosition.y,
      this.anchorSize,
      {
        color: 0x444444,
      },
    );
  }

  @on("destroy")
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
