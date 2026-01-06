import BaseEntity from "../core/entity/BaseEntity";
import { V, V2d } from "../core/Vector";
import type { Wind } from "./Wind";
import { WindModifier } from "./WindModifier";

// Turbulence particle configuration
const TURBULENCE_STRENGTH = 10; // Magnitude of chaotic velocity contribution
const TURBULENCE_RADIUS = 8; // Influence radius of each particle
const TURBULENCE_LIFETIME = 1.5; // Particle lifespan in seconds

/**
 * A turbulence particle that drifts with the wind and creates chaotic
 * disturbances in the wind field. Spawned by stalled sail segments.
 */
export class TurbulenceParticle extends BaseEntity implements WindModifier {
  tags = ["windModifier", "turbulence"];

  private age: number = 0;
  private intensity: number = 1.0;
  private seed: number;

  constructor(
    private position: V2d,
    private initialVelocity: V2d
  ) {
    super();
    // Use position hash as seed for deterministic chaos
    this.seed = Math.abs(
      Math.floor(position.x * 1000 + position.y * 7919)
    );
  }

  onTick(dt: number) {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    // Drift with the local wind
    const windVel = wind.getBaseVelocityAtPoint(this.position);
    this.position = this.position.add(windVel.mul(dt));

    // Age and decay intensity
    this.age += dt;
    this.intensity = Math.max(0, 1 - this.age / TURBULENCE_LIFETIME);

    // Self-destruct when faded
    if (this.age >= TURBULENCE_LIFETIME) {
      this.destroy();
    }
  }

  // WindModifier interface

  getWindModifierPosition(): V2d {
    return this.position;
  }

  getWindModifierInfluenceRadius(): number {
    return TURBULENCE_RADIUS;
  }

  getWindVelocityContribution(queryPoint: V2d): V2d {
    const toQuery = queryPoint.sub(this.position);
    const dist = toQuery.magnitude;

    if (dist > TURBULENCE_RADIUS || dist < 1) {
      return V(0, 0);
    }

    // Distance falloff
    const falloff = 1 - dist / TURBULENCE_RADIUS;

    // Seeded pseudo-random based on seed + age for deterministic chaos
    const t = this.age * 10;
    const chaos = this.seededNoise(t);

    const magnitude = this.intensity * TURBULENCE_STRENGTH * falloff;

    return chaos.mul(magnitude);
  }

  /**
   * Simple seeded noise function using LCG-based pseudo-random.
   * Returns a unit vector in a pseudo-random direction.
   */
  private seededNoise(t: number): V2d {
    // Linear congruential generator
    let seed = this.seed + Math.floor(t);
    seed = (seed * 1103515245 + 12345) | 0;
    const x = ((seed >> 16) & 0x7fff) / 0x7fff - 0.5;
    seed = (seed * 1103515245 + 12345) | 0;
    const y = ((seed >> 16) & 0x7fff) / 0x7fff - 0.5;

    return V(x * 2, y * 2);
  }
}
