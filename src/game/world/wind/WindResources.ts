/**
 * Wind GPU resource manager.
 *
 * Holds base wind state (velocity, angle, speed) and provides setters.
 * Provides base wind parameters to query shaders.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { V, type V2d } from "../../../core/Vector";

/**
 * Manages wind state for the wind query system.
 *
 * Simple entity holding base wind state. Wind modifiers are deferred
 * for later redesign - this only handles base wind queries.
 */
export class WindResources extends BaseEntity {
  id = "windResources";

  // Base wind velocity - the global wind direction and speed
  // ~15 ft/s (~9 kts), NW breeze
  private baseVelocity: V2d = V(11, 11);

  /**
   * Get the base wind velocity vector.
   */
  getBaseVelocity(): V2d {
    return this.baseVelocity.clone();
  }

  /**
   * Get the base wind speed.
   */
  getSpeed(): number {
    return this.baseVelocity.magnitude;
  }

  /**
   * Get the base wind angle in radians.
   */
  getAngle(): number {
    return this.baseVelocity.angle;
  }

  /**
   * Set the base wind velocity directly.
   */
  setVelocity(velocity: V2d): void {
    this.baseVelocity.set(velocity);
  }

  /**
   * Set the base wind from angle and speed.
   * @param angle Wind direction in radians (0 = east, PI/2 = north)
   * @param speed Wind speed in ft/s
   */
  setFromAngleAndSpeed(angle: number, speed: number): void {
    this.baseVelocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }
}
