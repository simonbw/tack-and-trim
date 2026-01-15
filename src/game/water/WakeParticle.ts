import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { AABB } from "../../core/util/SparseSpatialHash";
import { V2d } from "../../core/Vector";
import { WaterContribution, WaterModifier } from "./WaterModifier";
import type { WakeSegmentData } from "./webgpu/WaterComputeBuffers";

// Units: feet (ft), seconds
// Wake particle configuration
const DEFAULT_MAX_AGE = 4.0; // Default lifespan in seconds
const WARMUP_TIME = 0.3; // Seconds before particle affects physics
const BASE_RADIUS = 5; // Starting influence radius in ft
const MAX_RADIUS = 20; // Radius at end of life in ft
const DECAY_RATE = 1.5; // Intensity decay rate (1/s, dimensionless)
const VELOCITY_SCALE = 0.8; // Velocity contribution scale (dimensionless)
const WATER_VELOCITY_FACTOR = 0.0; // Percent that this affects water velocity
const HEIGHT_SCALE = 0.5; // Max height contribution in ft

// Shared zero contribution to avoid allocations
const ZERO_CONTRIBUTION: WaterContribution = {
  velocityX: 0,
  velocityY: 0,
  height: 0,
};

export type WakeSide = "left" | "right";

/**
 * A wake particle entity that represents a disturbance in the water.
 * Particles form linked chains (ribbons) on each side of the wake.
 * Each particle owns the segment from itself to its `next` neighbor.
 * Implements WaterModifier to contribute to water state queries.
 */
export class WakeParticle extends BaseEntity implements WaterModifier {
  tickLayer = "effects" as const;
  tags = ["waterModifier"];

  // Chain links for ribbon rendering
  prev: WakeParticle | null = null;
  next: WakeParticle | null = null;
  readonly side: WakeSide;

  // Position stored as separate numbers to avoid method call overhead
  private posX: number;
  private posY: number;
  private position: V2d;

  // Reusable AABB to avoid allocations
  private readonly aabb: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

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
    side: WakeSide,
    intensity: number = 1,
    maxAge: number = DEFAULT_MAX_AGE,
  ) {
    super();
    this.side = side;
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

  @on("tick")
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

  @on("destroy")
  onDestroy(): void {
    // Unlink from chain
    if (this.prev) {
      this.prev.next = null;
    }
    if (this.next) {
      this.next.prev = null;
    }
  }

  /** Check if we have a valid next particle to form a segment with */
  private hasNextSegment(): boolean {
    return this.next !== null && !this.next.isDestroyed;
  }

  // WaterModifier implementation

  /** Get the current influence radius based on age */
  getCurrentRadius(): number {
    // Radius expands from BASE_RADIUS to MAX_RADIUS over lifetime
    const ageFraction = Math.min(1, this.age / this.maxAge);
    return BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * ageFraction;
  }

  /** Get intensity multiplier that fades in during warmup */
  getWarmupMultiplier(): number {
    if (this.age >= WARMUP_TIME) return 1;
    return this.age / WARMUP_TIME;
  }

  getWaterModifierAABB(): AABB {
    const radius = this.getCurrentRadius();

    if (this.hasNextSegment()) {
      // Bounding box covers capsule from this position to next position
      const next = this.next!;
      const nextRadius = next.getCurrentRadius();
      const maxRadius = Math.max(radius, nextRadius);

      this.aabb.minX = Math.min(this.posX, next.posX) - maxRadius;
      this.aabb.minY = Math.min(this.posY, next.posY) - maxRadius;
      this.aabb.maxX = Math.max(this.posX, next.posX) + maxRadius;
      this.aabb.maxY = Math.max(this.posY, next.posY) + maxRadius;
    } else {
      // Tail particle - circular cap only
      this.aabb.minX = this.posX - radius;
      this.aabb.minY = this.posY - radius;
      this.aabb.maxX = this.posX + radius;
      this.aabb.maxY = this.posY + radius;
    }

    return this.aabb;
  }

  getWaterContribution(queryPoint: V2d): WaterContribution {
    if (this.hasNextSegment()) {
      return this.getSegmentContribution(queryPoint);
    } else {
      return this.getCircularContribution(queryPoint);
    }
  }

  /**
   * Segment-based contribution for particles with a next neighbor.
   * Calculates distance to the line segment and interpolates properties.
   */
  private getSegmentContribution(queryPoint: V2d): WaterContribution {
    const next = this.next!;

    // Segment vector from this to next
    const segX = next.posX - this.posX;
    const segY = next.posY - this.posY;
    const segLenSq = segX * segX + segY * segY;

    // Handle degenerate case (particles at same position)
    if (segLenSq < 0.001) {
      return this.getCircularContribution(queryPoint);
    }

    // Vector from this position to query point
    const toQueryX = queryPoint.x - this.posX;
    const toQueryY = queryPoint.y - this.posY;

    // Project query point onto segment (t=0 at this, t=1 at next)
    const t = Math.max(
      0,
      Math.min(1, (toQueryX * segX + toQueryY * segY) / segLenSq),
    );

    // Closest point on segment
    const closestX = this.posX + t * segX;
    const closestY = this.posY + t * segY;

    // Perpendicular distance from query point to segment
    const perpDx = queryPoint.x - closestX;
    const perpDy = queryPoint.y - closestY;
    const perpDistSq = perpDx * perpDx + perpDy * perpDy;

    // Interpolate radius along segment
    const thisRadius = this.getCurrentRadius();
    const nextRadius = next.getCurrentRadius();
    const radius = thisRadius + t * (nextRadius - thisRadius);

    if (perpDistSq >= radius * radius) return ZERO_CONTRIBUTION;

    const perpDist = Math.sqrt(perpDistSq);
    const normalizedDist = perpDist / radius; // 0 at center, 1 at edge

    // Interpolate intensity along segment, applying warmup fade-in
    const thisIntensity = this.intensity * this.getWarmupMultiplier();
    const nextIntensity = next.intensity * next.getWarmupMultiplier();
    const intensity = thisIntensity + t * (nextIntensity - thisIntensity);

    // Interpolate velocity along segment
    const velX = this.scaledVelX + t * (next.scaledVelX - this.scaledVelX);
    const velY = this.scaledVelY + t * (next.scaledVelY - this.scaledVelY);

    // Velocity uses linear falloff from ribbon center
    const linearFalloff = 1 - normalizedDist;
    const velFalloff = linearFalloff * intensity;
    this.contribution.velocityX = velX * velFalloff * WATER_VELOCITY_FACTOR;
    this.contribution.velocityY = velY * velFalloff * WATER_VELOCITY_FACTOR;

    // Height: cosine wave profile from ribbon center
    const waveProfile =
      Math.cos(normalizedDist * Math.PI) * (1 - normalizedDist);
    this.contribution.height = waveProfile * intensity * HEIGHT_SCALE;

    return this.contribution;
  }

  /**
   * Circular contribution for tail particles (no next neighbor).
   * Uses the original point-based calculation with rounded cap.
   */
  private getCircularContribution(queryPoint: V2d): WaterContribution {
    const radius = this.getCurrentRadius();
    const radiusSquared = radius * radius;

    const dx = queryPoint.x - this.posX;
    const dy = queryPoint.y - this.posY;
    const distSquared = dx * dx + dy * dy;

    if (distSquared >= radiusSquared) return ZERO_CONTRIBUTION;

    const dist = Math.sqrt(distSquared);
    const t = dist / radius; // 0 at center, 1 at edge

    // Apply warmup fade-in
    const intensity = this.intensity * this.getWarmupMultiplier();

    // Velocity uses linear falloff
    const linearFalloff = 1 - t;
    const velFalloff = linearFalloff * intensity;
    this.contribution.velocityX = this.scaledVelX * velFalloff;
    this.contribution.velocityY = this.scaledVelY * velFalloff;

    // Height: cosine wave profile
    const waveProfile = Math.cos(t * Math.PI) * (1 - t);
    this.contribution.height = waveProfile * intensity * HEIGHT_SCALE;

    return this.contribution;
  }

  /**
   * Export segment data for GPU compute shader.
   * Returns null if this particle should not contribute (destroyed, etc.)
   * For tail particles (no next), returns a degenerate segment (start == end).
   */
  getGPUSegmentData(): WakeSegmentData | null {
    if (this.isDestroyed) return null;

    const startRadius = this.getCurrentRadius();
    const startIntensity = this.intensity * this.getWarmupMultiplier();

    if (this.hasNextSegment()) {
      const next = this.next!;
      return {
        startX: this.posX,
        startY: this.posY,
        endX: next.posX,
        endY: next.posY,
        startRadius: startRadius,
        endRadius: next.getCurrentRadius(),
        startIntensity: startIntensity,
        endIntensity: next.intensity * next.getWarmupMultiplier(),
        startVelX: this.scaledVelX,
        startVelY: this.scaledVelY,
        endVelX: next.scaledVelX,
        endVelY: next.scaledVelY,
      };
    } else {
      // Tail particle - degenerate segment (circle)
      return {
        startX: this.posX,
        startY: this.posY,
        endX: this.posX,
        endY: this.posY,
        startRadius: startRadius,
        endRadius: startRadius,
        startIntensity: startIntensity,
        endIntensity: startIntensity,
        startVelX: this.scaledVelX,
        startVelY: this.scaledVelY,
        endVelX: this.scaledVelX,
        endVelY: this.scaledVelY,
      };
    }
  }
}
