import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../core/entity/BaseEntity";
import { V, V2d } from "../core/Vector";
import { WindModifier } from "./WindModifier";

// Wind variation configuration
const NOISE_SPATIAL_SCALE = 0.005; // How quickly wind varies across space
const NOISE_TIME_SCALE = 0.15; // How quickly wind varies over time
const SPEED_VARIATION = 0.5; // ±50% speed variation
const ANGLE_VARIATION = 0.17; // ±10° direction variation (~0.17 rad)

export class Wind extends BaseEntity {
  id = "wind";
  private baseVelocity: V2d = V(100, 100);
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();
  private modifiers: Set<WindModifier> = new Set();

  getVelocityAtPoint(point: V2d): V2d {
    const velocity = this.getBaseVelocityAtPoint(point);

    // Add contributions from all wind modifiers (sails, etc.)
    for (const modifier of this.modifiers) {
      const modifierPos = modifier.getWindModifierPosition();
      const influenceRadius = modifier.getWindModifierInfluenceRadius();
      const distanceSquared = point.squaredDistanceTo(modifierPos);

      if (distanceSquared <= influenceRadius * influenceRadius) {
        velocity.iadd(modifier.getWindVelocityContribution(point));
      }
    }

    return velocity;
  }

  /** Get base wind velocity from noise field, without modifier contributions. */
  getBaseVelocityAtPoint([x, y]: V2d): V2d {
    const t = this.game!.elapsedUnpausedTime * NOISE_TIME_SCALE;

    const sx = x * NOISE_SPATIAL_SCALE;
    const sy = y * NOISE_SPATIAL_SCALE;
    // Sample noise for speed and angle variation
    const speedScale = 1 + this.speedNoise(sx, sy, t) * SPEED_VARIATION;
    const angleVariance = this.angleNoise(sx, sy, t) * ANGLE_VARIATION;

    return this.baseVelocity.mul(speedScale).irotate(angleVariance);
  }

  registerModifier(modifier: WindModifier): void {
    this.modifiers.add(modifier);
  }

  unregisterModifier(modifier: WindModifier): void {
    this.modifiers.delete(modifier);
  }

  setVelocity(velocity: V2d): void {
    this.baseVelocity.set(velocity);
  }

  setFromAngleAndSpeed(angle: number, speed: number): void {
    this.baseVelocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  getSpeed(): number {
    return this.baseVelocity.magnitude;
  }

  getAngle(): number {
    return this.baseVelocity.angle;
  }

  /** Get all registered wind modifiers (for visualization). */
  getModifiers(): ReadonlySet<WindModifier> {
    return this.modifiers;
  }
}
