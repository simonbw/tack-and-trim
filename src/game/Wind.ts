import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../core/entity/BaseEntity";
import { profile } from "../core/util/Profiler";
import { SparseSpatialHash } from "../core/util/SparseSpatialHash";
import { V, V2d } from "../core/Vector";
import { WindInfo } from "./wind/WindInfo";
import { WindModifier } from "./WindModifier";

// Units: ft/s for velocity
// Wind variation configuration
const NOISE_SPATIAL_SCALE = 0.005; // How quickly wind varies across space
const NOISE_TIME_SCALE = 0.15; // How quickly wind varies over time
const SPEED_VARIATION = 0.5; // ±50% speed variation
const ANGLE_VARIATION = 0.17; // ±10° direction variation (~0.17 rad)

export class Wind extends BaseEntity {
  id = "wind";
  private baseVelocity: V2d = V(11, 11); // ~15 ft/s (~9 kts), NW breeze
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();
  private spatialHash = new SparseSpatialHash<WindModifier>((m) =>
    m.getWindModifierAABB(),
  );
  private windInfo: WindInfo | null = null;

  onAdd() {
    // Get or create WindInfo for GPU-accelerated wind queries
    this.windInfo = WindInfo.fromGame(this.game!);
  }

  @profile
  onTick() {
    // Rebuild spatial hash from all wind modifiers (for CPU fallback)
    this.spatialHash.clear();
    const modifiers = this.game!.entities.getTagged("windModifier");
    for (const modifier of modifiers) {
      this.spatialHash.add(modifier as unknown as WindModifier);
    }
  }

  getVelocityAtPoint(point: V2d): V2d {
    // Try GPU path first (includes modifiers)
    if (this.windInfo) {
      const result = this.windInfo.getVelocityAtPoint(point);
      if (result) return result;
    }

    // CPU fallback: base wind + modifiers
    const velocity = this.getBaseVelocityAtPoint(point);

    // Query spatial hash for modifiers that might affect this point
    for (const modifier of this.spatialHash.queryPoint(point)) {
      velocity.iadd(modifier.getWindVelocityContribution(point));
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

  /** Get all wind modifiers (for visualization). */
  getModifiers(): readonly WindModifier[] {
    return this.game!.entities.getTagged(
      "windModifier",
    ) as unknown as readonly WindModifier[];
  }
}
