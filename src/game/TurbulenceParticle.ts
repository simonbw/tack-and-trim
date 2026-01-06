import BaseEntity from "../core/entity/BaseEntity";
import { V, V2d } from "../core/Vector";
import type { Wind } from "./Wind";
import { WindModifier } from "./WindModifier";

// Turbulence configuration
const DEFAULT_MAX_AGE = 1.5; // seconds
const DEFAULT_RADIUS = 8; // influence radius
const DEFAULT_INTENSITY = 12; // base velocity magnitude
const INTENSITY_DECAY_RATE = 2.0; // how fast intensity fades (higher = faster)
const MIN_DISTANCE = 2; // minimum distance for contribution

/**
 * A particle that drifts with the wind and adds chaotic velocity perturbations.
 * Spawned from stalled sail segments to create realistic turbulence that
 * propagates downwind rather than appearing as instant random noise.
 */
export class TurbulenceParticle extends BaseEntity implements WindModifier {
  private position: V2d;
  private velocity: V2d;
  private intensity: number;
  private age: number = 0;
  private readonly maxAge: number;
  private readonly radius: number;

  // Pseudo-random offsets for deterministic chaos (seeded by spawn position)
  private readonly phaseX: number;
  private readonly phaseY: number;
  private readonly freqX: number;
  private readonly freqY: number;

  constructor(
    spawnPosition: V2d,
    initialVelocity: V2d,
    options: {
      intensity?: number;
      maxAge?: number;
      radius?: number;
    } = {}
  ) {
    super();

    this.position = spawnPosition.clone();
    this.velocity = initialVelocity.clone();
    this.intensity = options.intensity ?? DEFAULT_INTENSITY;
    this.maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
    this.radius = options.radius ?? DEFAULT_RADIUS;

    // Seed pseudo-random parameters from spawn position for deterministic behavior
    const seed1 = (spawnPosition.x * 12.9898 + spawnPosition.y * 78.233) % 1000;
    const seed2 = (spawnPosition.x * 43.332 + spawnPosition.y * 93.112) % 1000;
    this.phaseX = seed1 * 0.01;
    this.phaseY = seed2 * 0.01;
    this.freqX = 8 + (seed1 % 4);
    this.freqY = 8 + (seed2 % 4);
  }

  onAdd() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    wind?.registerModifier(this);
  }

  onDestroy() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    wind?.unregisterModifier(this);
  }

  onTick(dt: number) {
    this.age += dt;

    // Destroy when too old or faded
    if (this.age >= this.maxAge || this.intensity < 0.1) {
      this.destroy();
      return;
    }

    // Decay intensity over time
    this.intensity *= Math.exp(-INTENSITY_DECAY_RATE * dt);

    // Update velocity from local wind
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (wind) {
      // Use base wind to avoid feedback loops with own contribution
      const windVel = wind.getBaseVelocityAtPoint(this.position);
      // Blend toward wind velocity (particle is carried by wind)
      this.velocity.ilerp(windVel, 0.1);
    }

    // Move with velocity
    this.position.iadd(this.velocity.mul(dt));
  }

  // WindModifier interface

  getWindModifierPosition(): V2d {
    return this.position;
  }

  getWindModifierInfluenceRadius(): number {
    return this.radius;
  }

  getWindVelocityContribution(queryPoint: V2d): V2d {
    const toQuery = queryPoint.sub(this.position);
    const distance = toQuery.magnitude;

    if (distance < MIN_DISTANCE || distance > this.radius) {
      return V(0, 0);
    }

    // Falloff with distance
    const falloff = 1 - distance / this.radius;

    // Time-varying chaotic velocity using seeded sinusoids
    // This creates coherent turbulence rather than pure random noise
    const t = this.age;
    const chaosX = Math.sin(this.freqX * t + this.phaseX) * this.intensity;
    const chaosY = Math.cos(this.freqY * t + this.phaseY) * this.intensity;

    return V(chaosX * falloff, chaosY * falloff);
  }
}
