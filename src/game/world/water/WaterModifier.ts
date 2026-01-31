/**
 * WaterModifier: Abstract base entity class for water surface modifiers.
 *
 * Water modifiers affect the water simulation locally:
 * - Wakes: Ripples from moving objects
 * - Currents: Local velocity fields
 * - Obstacles: Damping zones
 *
 * Modifiers are collected via game.entities.byConstructor(WaterModifier) and uploaded to GPU.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { AABB } from "../../../core/physics/collision/AABB";
import { V, V2d } from "../../../core/Vector";

/**
 * Type-discriminated union for modifier data
 */
export type WaterModifierData =
  | { type: "wake"; strength: number; direction: number }
  | { type: "current"; velocity: { x: number; y: number } }
  | { type: "obstacle"; dampingFactor: number };

/**
 * Abstract base class for water modifiers.
 *
 * Subclasses must implement:
 * - getBounds(): Return world-space AABB for spatial culling
 * - getModifierData(): Return type-specific modifier data
 */
export abstract class WaterModifier extends BaseEntity {
  /**
   * Get world-space bounding box for this modifier.
   * Used for spatial culling during water computation.
   *
   * @returns AABB in world space
   */
  abstract getBounds(): AABB;

  /**
   * Get type-specific modifier data for GPU upload.
   *
   * @returns Modifier data with discriminated type
   */
  abstract getModifierData(): WaterModifierData;
}

/**
 * Wake modifier: Creates ripples from moving objects (boats, debris).
 *
 * Generates concentric waves radiating from a point.
 */
export class WakeModifier extends WaterModifier {
  constructor(
    private position: V2d,
    private strength: number,
    private direction: number,
    private radius: number = 50,
  ) {
    super();
  }

  getBounds(): AABB {
    return new AABB({
      lowerBound: this.position.sub(V(this.radius, this.radius)),
      upperBound: this.position.add(V(this.radius, this.radius)),
    });
  }

  getModifierData(): WaterModifierData {
    return {
      type: "wake",
      strength: this.strength,
      direction: this.direction,
    };
  }

  /**
   * Update wake position (call from parent entity's tick)
   */
  setPosition(position: V2d): void {
    this.position = position;
  }

  /**
   * Update wake strength (based on velocity)
   */
  setStrength(strength: number): void {
    this.strength = strength;
  }

  /**
   * Update wake direction (based on movement direction)
   */
  setDirection(direction: number): void {
    this.direction = direction;
  }
}

/**
 * Current modifier: Creates local water currents.
 *
 * Applies velocity field to water in a region (tides, rivers, eddies).
 */
export class CurrentModifier extends WaterModifier {
  constructor(
    private center: V2d,
    private velocity: V2d,
    private radius: number = 100,
  ) {
    super();
  }

  getBounds(): AABB {
    return new AABB({
      lowerBound: this.center.sub(V(this.radius, this.radius)),
      upperBound: this.center.add(V(this.radius, this.radius)),
    });
  }

  getModifierData(): WaterModifierData {
    return {
      type: "current",
      velocity: {
        x: this.velocity.x,
        y: this.velocity.y,
      },
    };
  }

  /**
   * Update current velocity
   */
  setVelocity(velocity: V2d): void {
    this.velocity = velocity;
  }
}

/**
 * Obstacle modifier: Dampens waves in a region.
 *
 * Used for shallow water, vegetation, or artificial wave dampeners.
 */
export class ObstacleModifier extends WaterModifier {
  constructor(
    private center: V2d,
    private dampingFactor: number,
    private radius: number = 75,
  ) {
    super();
  }

  getBounds(): AABB {
    return new AABB({
      lowerBound: this.center.sub(V(this.radius, this.radius)),
      upperBound: this.center.add(V(this.radius, this.radius)),
    });
  }

  getModifierData(): WaterModifierData {
    return {
      type: "obstacle",
      dampingFactor: this.dampingFactor,
    };
  }

  /**
   * Update damping factor (0 = no damping, 1 = full damping)
   */
  setDampingFactor(dampingFactor: number): void {
    this.dampingFactor = dampingFactor;
  }
}
