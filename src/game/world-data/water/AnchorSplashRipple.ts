import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { AABB } from "../../../core/util/SparseSpatialHash";
import { V2d } from "../../../core/Vector";
import { WaterContribution, WaterModifier } from "./WaterModifier";

// Configuration
const MAX_AGE = 2.0; // Lifespan in seconds
const WARMUP_TIME = 0.1; // Seconds before affecting physics
const INITIAL_RADIUS = 1.0; // Starting radius in ft
const MAX_RADIUS = 15.0; // Maximum expansion radius in ft
const HEIGHT_SCALE = 0.8; // Peak wave height in ft
const DECAY_RATE = 2.0; // Intensity decay rate (1/s)
const RING_WIDTH = 2.0; // Width of the ripple ring in ft

// Shared zero contribution to avoid allocations
const ZERO_CONTRIBUTION: WaterContribution = {
  velocityX: 0,
  velocityY: 0,
  height: 0,
};

/**
 * A circular ripple effect that expands outward from a splash point.
 * Implements WaterModifier to affect water surface height.
 */
export class AnchorSplashRipple extends BaseEntity implements WaterModifier {
  tags = ["waterModifier"];

  private posX: number;
  private posY: number;
  private intensity: number = 1.0;
  private age: number = 0;

  // Reusable objects to avoid allocations
  private readonly aabb: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly contribution: WaterContribution = {
    velocityX: 0,
    velocityY: 0,
    height: 0,
  };

  constructor(position: V2d) {
    super();
    this.posX = position.x;
    this.posY = position.y;
  }

  @on("tick")
  onTick(dt: number): void {
    this.age += dt;

    // Decay intensity over time
    this.intensity *= 1 - DECAY_RATE * dt;

    // Self-destruct when old or faded
    if (this.age >= MAX_AGE || this.intensity < 0.01) {
      this.destroy();
    }
  }

  private getCurrentRadius(): number {
    const ageFraction = Math.min(1, this.age / MAX_AGE);
    return INITIAL_RADIUS + (MAX_RADIUS - INITIAL_RADIUS) * ageFraction;
  }

  private getWarmupMultiplier(): number {
    return Math.min(1, this.age / WARMUP_TIME);
  }

  getWaterModifierAABB(): AABB {
    const radius = this.getCurrentRadius() + RING_WIDTH;
    this.aabb.minX = this.posX - radius;
    this.aabb.minY = this.posY - radius;
    this.aabb.maxX = this.posX + radius;
    this.aabb.maxY = this.posY + radius;
    return this.aabb;
  }

  getWaterContribution(queryPoint: V2d): Readonly<WaterContribution> {
    const ringRadius = this.getCurrentRadius();
    const maxDist = ringRadius + RING_WIDTH;

    const dx = queryPoint.x - this.posX;
    const dy = queryPoint.y - this.posY;
    const distSquared = dx * dx + dy * dy;

    // Quick rejection if too far
    if (distSquared > maxDist * maxDist) return ZERO_CONTRIBUTION;

    const dist = Math.sqrt(distSquared);

    // Distance from the expanding ring edge
    const distFromRing = Math.abs(dist - ringRadius);

    // Outside ring influence
    if (distFromRing > RING_WIDTH) return ZERO_CONTRIBUTION;

    // Apply warmup fade-in
    const intensity = this.intensity * this.getWarmupMultiplier();

    // Wave profile within ring - cosine creates smooth wave shape
    const ringT = distFromRing / RING_WIDTH; // 0 at ring edge, 1 at ring boundary
    const waveProfile = Math.cos(ringT * Math.PI * 0.5); // Smooth falloff

    // Height contribution - positive for crest
    this.contribution.height = waveProfile * intensity * HEIGHT_SCALE;
    this.contribution.velocityX = 0;
    this.contribution.velocityY = 0;

    return this.contribution;
  }
}
