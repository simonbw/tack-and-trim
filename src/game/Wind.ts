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
  private velocity: V2d = V(100, 100);
  private elapsedTime: number = 0;
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();
  private modifiers: Set<WindModifier> = new Set();

  onTick(dt: number) {
    this.elapsedTime += dt;
  }

  getVelocity(): V2d {
    return V(this.velocity);
  }

  getVelocityAtPoint(point: [number, number]): V2d {
    const queryPoint = V(point[0], point[1]);
    let velocity = this.getBaseVelocityAtPoint(point);

    // Add contributions from all wind modifiers (sails, etc.)
    for (const modifier of this.modifiers) {
      const modifierPos = modifier.getWindModifierPosition();
      const influenceRadius = modifier.getWindModifierInfluenceRadius();
      const distance = queryPoint.sub(modifierPos).magnitude;

      if (distance <= influenceRadius) {
        velocity = velocity.add(modifier.getWindVelocityContribution(queryPoint));
      }
    }

    return velocity;
  }

  /** Get base wind velocity from noise field, without modifier contributions. */
  getBaseVelocityAtPoint(point: [number, number]): V2d {
    const [x, y] = point;
    const t = this.elapsedTime * NOISE_TIME_SCALE;

    // Sample noise for speed and angle variation
    const speedMod =
      1 +
      this.speedNoise(x * NOISE_SPATIAL_SCALE, y * NOISE_SPATIAL_SCALE, t) *
        SPEED_VARIATION;
    const angleMod =
      this.angleNoise(x * NOISE_SPATIAL_SCALE, y * NOISE_SPATIAL_SCALE, t) *
      ANGLE_VARIATION;

    // Apply modifications to base velocity
    const baseSpeed = this.velocity.magnitude;
    const baseAngle = this.velocity.angle;

    const newSpeed = baseSpeed * speedMod;
    const newAngle = baseAngle + angleMod;

    return V(Math.cos(newAngle) * newSpeed, Math.sin(newAngle) * newSpeed);
  }

  registerModifier(modifier: WindModifier): void {
    this.modifiers.add(modifier);
  }

  unregisterModifier(modifier: WindModifier): void {
    this.modifiers.delete(modifier);
  }

  setVelocity(velocity: V2d): void {
    this.velocity.set(velocity);
  }

  setFromAngleAndSpeed(angle: number, speed: number): void {
    this.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  getSpeed(): number {
    return this.velocity.magnitude;
  }

  getAngle(): number {
    return this.velocity.angle;
  }
}
