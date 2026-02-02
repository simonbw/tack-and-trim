import { on } from "../../../core/entity/handler";
import { AABB } from "../../../core/physics/collision/AABB";
import { V2d } from "../../../core/Vector";
import {
  GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "./WaterModifierBase";

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

export type WakeSide = "left" | "right";

/**
 * A wake particle entity that represents a disturbance in the water.
 * Particles form linked chains (ribbons) on each side of the wake.
 * Each particle owns the segment from itself to its `next` neighbor.
 * Implements WaterModifier to contribute to water state queries.
 */
export class WakeParticle extends WaterModifier {
  tickLayer = "effects" as const;

  // Chain links for ribbon rendering
  prev: WakeParticle | null = null;
  next: WakeParticle | null = null;
  readonly side: WakeSide;

  // Position stored as separate numbers to avoid method call overhead
  private posX: number;
  private posY: number;
  private position: V2d;

  // Reusable AABB to avoid allocations
  private readonly aabb: AABB = new AABB();

  // Movement velocity (actual position change per second)
  private velX: number;
  private velY: number;

  // Pre-scaled velocity for water contribution (already multiplied by VELOCITY_SCALE)
  private scaledVelX: number;
  private scaledVelY: number;

  private intensity: number;
  private age: number = 0;
  private maxAge: number;

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

      this.aabb.lowerBound.x = Math.min(this.posX, next.posX) - maxRadius;
      this.aabb.lowerBound.y = Math.min(this.posY, next.posY) - maxRadius;
      this.aabb.upperBound.x = Math.max(this.posX, next.posX) + maxRadius;
      this.aabb.upperBound.y = Math.max(this.posY, next.posY) + maxRadius;
    } else {
      // Tail particle - circular cap only
      this.aabb.lowerBound.x = this.posX - radius;
      this.aabb.lowerBound.y = this.posY - radius;
      this.aabb.upperBound.x = this.posX + radius;
      this.aabb.upperBound.y = this.posY + radius;
    }

    return this.aabb;
  }

  /**
   * Export modifier data for GPU compute shader.
   * Returns null if this particle should not contribute (destroyed, too old, etc.)
   */
  getGPUModifierData(): GPUWaterModifierData | null {
    // Don't contribute if destroyed or past max age
    if (this.isDestroyed || this.age > this.maxAge) return null;

    const warmup = this.getWarmupMultiplier();
    const intensity = this.intensity * warmup;

    // Don't contribute if faded out
    if (intensity < 0.01) return null;

    return {
      type: WaterModifierType.Wake,
      bounds: this.getWaterModifierAABB(),
      data: {
        type: WaterModifierType.Wake,
        intensity: intensity * HEIGHT_SCALE,
        velocityX: this.scaledVelX * WATER_VELOCITY_FACTOR,
        velocityY: this.scaledVelY * WATER_VELOCITY_FACTOR,
      },
    };
  }
}
