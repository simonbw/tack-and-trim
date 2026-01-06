import BaseEntity from "../../core/entity/BaseEntity";
import { V, V2d } from "../../core/Vector";

/**
 * A wake particle that represents a disturbance in the water.
 * These spread outward from boats and decay over time.
 */
interface WakeParticle {
  position: V2d;
  velocity: V2d; // The velocity this particle imparts to the water
  intensity: number; // 0-1, decays over time
  age: number;
}

// Wake physics configuration
const CONFIG = {
  MAX_AGE: 4.0, // Seconds before particle is removed
  WARMUP_TIME: 0.5, // Seconds before particle affects physics (lets boat move away)
  INFLUENCE_RADIUS: 40, // How far each particle affects the water
  DECAY_RATE: 0.5, // How quickly intensity decays (per second)
  VELOCITY_SCALE: 0.8, // Scale factor for wake velocity effect
  HEIGHT_SCALE: 3.0, // Max height contribution from wake (in world units)
  MAX_PARTICLES: 500, // Cap to prevent performance issues
};

/**
 * WakeField manages wake particles that affect water physics.
 * Boats spawn wake particles, and Water queries this field
 * to get velocity contributions from nearby wakes.
 */
export class WakeField extends BaseEntity {
  id = "wakeField";
  private particles: WakeParticle[] = [];

  /**
   * Spawn a wake particle at a position with given velocity.
   * @param position World position of the wake disturbance
   * @param velocity Velocity the wake imparts to the water (typically outward from boat)
   * @param intensity Initial intensity (0-1), defaults to 1
   */
  spawnParticle(position: V2d, velocity: V2d, intensity: number = 1): void {
    // Don't exceed max particles - remove oldest if needed
    if (this.particles.length >= CONFIG.MAX_PARTICLES) {
      this.particles.shift();
    }

    this.particles.push({
      position: position.clone(),
      velocity: velocity.clone(),
      intensity,
      age: 0,
    });
  }

  onTick(dt: number): void {
    // Update all particles
    for (const particle of this.particles) {
      particle.age += dt;
      // Decay intensity over time
      particle.intensity *= 1 - CONFIG.DECAY_RATE * dt;
    }

    // Remove dead particles
    this.particles = this.particles.filter(
      (p) => p.age < CONFIG.MAX_AGE && p.intensity > 0.01
    );
  }

  /**
   * Get the wake velocity contribution at a world position.
   * Sums contributions from all nearby wake particles.
   * Particles need to "warm up" before affecting physics (lets boat move away).
   */
  getVelocityAtPoint(point: V2d): V2d {
    const result = V(0, 0);
    const radiusSquared = CONFIG.INFLUENCE_RADIUS * CONFIG.INFLUENCE_RADIUS;

    for (const particle of this.particles) {
      // Skip particles that haven't warmed up yet
      if (particle.age < CONFIG.WARMUP_TIME) continue;

      const distSquared = point.squaredDistanceTo(particle.position);

      if (distSquared < radiusSquared) {
        // Linear falloff based on distance
        const dist = Math.sqrt(distSquared);
        const falloff = 1 - dist / CONFIG.INFLUENCE_RADIUS;

        // Add scaled velocity contribution
        result.iaddScaled(
          particle.velocity,
          falloff * particle.intensity * CONFIG.VELOCITY_SCALE
        );
      }
    }

    return result;
  }

  /**
   * Get wake height contribution at a point.
   * Creates a bump/displacement in the water surface.
   */
  getHeightAtPoint(point: V2d): number {
    let totalHeight = 0;
    const radiusSquared = CONFIG.INFLUENCE_RADIUS * CONFIG.INFLUENCE_RADIUS;

    for (const particle of this.particles) {
      // Skip particles that haven't warmed up yet
      if (particle.age < CONFIG.WARMUP_TIME) continue;

      const distSquared = point.squaredDistanceTo(particle.position);

      if (distSquared < radiusSquared) {
        const dist = Math.sqrt(distSquared);
        // Smooth falloff (quadratic looks more natural for wave shape)
        const t = dist / CONFIG.INFLUENCE_RADIUS;
        const falloff = (1 - t) * (1 - t);

        totalHeight += falloff * particle.intensity * CONFIG.HEIGHT_SCALE;
      }
    }

    return totalHeight;
  }

  /**
   * Get wake intensity at a point (for visual effects like foam).
   */
  getIntensityAtPoint(point: V2d): number {
    let totalIntensity = 0;
    const radiusSquared = CONFIG.INFLUENCE_RADIUS * CONFIG.INFLUENCE_RADIUS;

    for (const particle of this.particles) {
      // Skip particles that haven't warmed up yet
      if (particle.age < CONFIG.WARMUP_TIME) continue;

      const distSquared = point.squaredDistanceTo(particle.position);

      if (distSquared < radiusSquared) {
        const dist = Math.sqrt(distSquared);
        const falloff = 1 - dist / CONFIG.INFLUENCE_RADIUS;
        totalIntensity += falloff * particle.intensity;
      }
    }

    return Math.min(totalIntensity, 1);
  }

  /**
   * Get all particles (for debugging/visualization).
   */
  getParticles(): ReadonlyArray<WakeParticle> {
    return this.particles;
  }
}
