import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { AABB } from "../../core/physics/collision/AABB";
import { V2d } from "../../core/Vector";
import {
  GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "../world/water/WaterModifierBase";

// Configuration
const MAX_AGE = 2.0; // Lifespan in seconds
const WARMUP_TIME = 0.1; // Seconds before affecting physics
const INITIAL_RADIUS = 1.0; // Starting radius in ft
const MAX_RADIUS = 15.0; // Maximum expansion radius in ft
const HEIGHT_SCALE = 0.8; // Peak wave height in ft
const DECAY_RATE = 2.0; // Intensity decay rate (1/s)
const RING_WIDTH = 2.0; // Width of the ripple ring in ft

/**
 * A circular ripple effect that expands outward from a splash point.
 * Extends WaterModifier to affect water surface height via GPU compute.
 */
export class AnchorSplashRipple extends WaterModifier {
  private posX: number;
  private posY: number;
  private intensity: number = 1.0;
  private age: number = 0;

  // Reusable AABB to avoid allocations
  private readonly aabb: AABB = new AABB();

  constructor(position: V2d) {
    super();
    this.posX = position.x;
    this.posY = position.y;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
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
    this.aabb.lowerBound.x = this.posX - radius;
    this.aabb.lowerBound.y = this.posY - radius;
    this.aabb.upperBound.x = this.posX + radius;
    this.aabb.upperBound.y = this.posY + radius;
    return this.aabb;
  }

  /**
   * Export modifier data for GPU compute shader.
   * Returns null if this ripple should not contribute (destroyed, too old, etc.)
   */
  getGPUModifierData(): GPUWaterModifierData | null {
    // Don't contribute if destroyed or past max age
    if (this.isDestroyed || this.age >= MAX_AGE) return null;

    const intensity = this.intensity * this.getWarmupMultiplier();

    // Don't contribute if faded out
    if (intensity < 0.01) return null;

    return {
      type: WaterModifierType.Ripple,
      bounds: this.getWaterModifierAABB(),
      data: {
        type: WaterModifierType.Ripple,
        radius: this.getCurrentRadius(),
        intensity: intensity * HEIGHT_SCALE,
        phase: (this.age / MAX_AGE) * Math.PI * 2,
      },
    };
  }
}
