import BaseEntity from "../../core/entity/BaseEntity";
import { V2d } from "../../core/Vector";
import { WaterContribution, WaterModifier } from "./WaterModifier";

// Wake particle configuration
const DEFAULT_MAX_AGE = 4.0; // Default lifespan if not specified
const WARMUP_TIME = 0.3; // Seconds before particle affects physics (reduced since particles move away)
const BASE_RADIUS = 15; // Starting influence radius
const MAX_RADIUS = 60; // Radius at end of life
const DECAY_RATE = 0.5; // How quickly intensity decays (per second)
const VELOCITY_SCALE = 0.8; // Scale factor for wake velocity effect
const HEIGHT_SCALE = 0.25; // Max height contribution from wake (kept low so overlapping particles can build up)

// Shared zero contribution to avoid allocations
const ZERO_CONTRIBUTION: WaterContribution = {
  velocityX: 0,
  velocityY: 0,
  height: 0,
};

/**
 * A wake particle entity that represents a disturbance in the water.
 * These spread outward from boats and decay over time.
 * Implements WaterModifier to contribute to water state queries.
 */
export class WakeParticle extends BaseEntity implements WaterModifier {
  tags = ["waterModifier"];

  // Position stored as separate numbers to avoid method call overhead
  private posX: number;
  private posY: number;
  private position: V2d; // Keep for spatial hash interface

  // Movement velocity (actual position change per second)
  private velX: number;
  private velY: number;

  // Pre-scaled velocity for water contribution (already multiplied by VELOCITY_SCALE)
  private scaledVelX: number;
  private scaledVelY: number;

  private intensity: number;
  private age: number = 0;
  private maxAge: number;

  // Reusable result object to avoid allocations
  private readonly contribution: WaterContribution = {
    velocityX: 0,
    velocityY: 0,
    height: 0,
  };

  constructor(
    position: V2d,
    velocity: V2d,
    intensity: number = 1,
    maxAge: number = DEFAULT_MAX_AGE
  ) {
    super();
    this.posX = position.x;
    this.posY = position.y;
    this.position = position.clone();
    // Store velocity for both movement and water contribution
    this.velX = velocity.x;
    this.velY = velocity.y;
    this.scaledVelX = velocity.x * VELOCITY_SCALE;
    this.scaledVelY = velocity.y * VELOCITY_SCALE;
    this.intensity = intensity;
    this.maxAge = maxAge;
  }

  onTick(dt: number): void {
    this.age += dt;

    // Move outward based on velocity
    this.posX += this.velX * dt;
    this.posY += this.velY * dt;
    this.position.x = this.posX;
    this.position.y = this.posY;

    // Decay intensity over time
    this.intensity *= 1 - DECAY_RATE * dt;

    // Self-destruct when faded or too old
    if (this.age >= this.maxAge || this.intensity < 0.01) {
      this.destroy();
    }
  }

  // WaterModifier implementation

  getWaterModifierPosition(): V2d {
    return this.position;
  }

  getWaterModifierInfluenceRadius(): number {
    // Return 0 during warmup so we don't affect nearby water yet
    if (this.age < WARMUP_TIME) {
      return 0;
    }
    // Radius expands from BASE_RADIUS to MAX_RADIUS over lifetime
    const ageFraction = Math.min(1, this.age / this.maxAge);
    return BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * ageFraction;
  }

  getWaterContribution(queryPoint: V2d): WaterContribution {
    // Calculate current radius (same formula as getWaterModifierInfluenceRadius)
    const ageFraction = Math.min(1, this.age / this.maxAge);
    const radius = BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * ageFraction;
    const radiusSquared = radius * radius;

    // Inline distance calculation to avoid method call
    const dx = queryPoint.x - this.posX;
    const dy = queryPoint.y - this.posY;
    const distSquared = dx * dx + dy * dy;

    if (distSquared >= radiusSquared) return ZERO_CONTRIBUTION;

    // Compute distance and falloff
    const dist = Math.sqrt(distSquared);
    const t = dist / radius;
    const linearFalloff = 1 - t;
    const quadraticFalloff = linearFalloff * linearFalloff;

    const intensity = this.intensity;

    // Velocity uses linear falloff (velocity already pre-scaled)
    const velFalloff = linearFalloff * intensity;
    this.contribution.velocityX = this.scaledVelX * velFalloff;
    this.contribution.velocityY = this.scaledVelY * velFalloff;

    // Height uses quadratic falloff for smoother wave shape
    this.contribution.height = quadraticFalloff * intensity * HEIGHT_SCALE;

    return this.contribution;
  }
}
