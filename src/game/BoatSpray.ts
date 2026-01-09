import BaseEntity from "../core/entity/BaseEntity";
import { clamp, invLerp, lerp, lerpV2d } from "../core/util/MathUtil";
import { rNormal, rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";

// Units: ft, ft/s, seconds
const CONFIG = {
  // Particle lifecycle
  MAX_AGE: 1.0, // seconds (flight time before forced destroy)

  // Speed thresholds
  MIN_SPEED: 5, // ft/s (~3 kts) - spray starts appearing
  MAX_SPEED: 20, // ft/s (~7 kts) - hull speed limit

  // Spawning
  SPAWN_RATE: 1000, // Base particles per second at max speed

  // Physics (in ft and ft/s)
  SPRAY_SPEED: 10, // ft/s - how fast particles spray outward from hull
  INITIAL_VZ: 18, // ft/s - initial upward velocity
  GRAVITY: 32, // ft/s² - gravitational acceleration (real gravity)
  DRAG: 6.0, // 1/s - air drag so droplets slow and trail behind boat

  // Rendering
  COLOR: 0xffffff,
  MIN_ALPHA: 0.7,
  MAX_ALPHA: 1.0,
  MIN_SIZE: 0.05, // ft (~1.5 cm diameter)
  MAX_SIZE: 0.12, // ft (~3.6 cm diameter)

  // Splash (when hitting water)
  SPLASH_DURATION: 2.0, // seconds
  SPLASH_GROW_SCALE: 3.0, // multiplier
};

/**
 * A single spray particle with position, velocity, and state.
 */
class SprayParticle {
  pos: V2d;
  vel: V2d;
  z: number; // Height above water
  vz: number; // Vertical velocity
  age: number = 0;
  size: number;
  destroyed: boolean = false;

  // Splash state (when particle hits water)
  splashing: boolean = false;
  splashAge: number = 0;

  constructor(pos: V2d, vel: V2d, vz: number, size: number) {
    this.pos = pos;
    this.vel = vel;
    this.z = 0.1;
    this.vz = vz;
    this.size = size;
  }

  update(dt: number): void {
    if (this.splashing) {
      // Splash phase: grow and fade, then destroy
      this.splashAge += dt;
      if (this.splashAge >= CONFIG.SPLASH_DURATION) {
        this.destroyed = true;
      }
    } else {
      // Flying phase: physics update
      this.age += dt;
      this.vz -= CONFIG.GRAVITY * dt;
      this.z += this.vz * dt;
      this.pos.iaddScaled(this.vel, dt);
      this.vel.imul(Math.exp(-CONFIG.DRAG * dt));

      // Check if hit water
      if (this.z <= 0) {
        this.splashing = true;
        this.z = 0;
        this.vel.set(0, 0);
        this.vz = 0;
      }
    }
  }

  /** Get current visual alpha */
  getAlpha(): number {
    if (this.splashing) {
      // Fade out during splash
      const t = this.splashAge / CONFIG.SPLASH_DURATION;
      return CONFIG.MAX_ALPHA * (1 - t);
    } else {
      // Full opacity while flying
      return CONFIG.MAX_ALPHA;
    }
  }

  /** Get current visual radius */
  getRadius(): number {
    if (this.splashing) {
      const t = this.splashAge / CONFIG.SPLASH_DURATION;
      return this.size * lerp(1, CONFIG.SPLASH_GROW_SCALE, t);
    } else {
      return this.size * (1 + this.z * 0.02);
    }
  }
}

export class BoatSpray extends BaseEntity {
  layer = "wake" as const;

  private particles: SprayParticle[] = [];
  private spawnAccumulator = 0;

  constructor(private boat: Boat) {
    super();
  }

  onTick(dt: number): void {
    // Update and remove destroyed particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update(dt);
      if (this.particles[i].destroyed) {
        this.particles.splice(i, 1);
      }
    }

    this.spawnParticles(dt);
  }

  onRender({ draw }: { draw: import("../core/graphics/Draw").Draw }): void {
    for (const p of this.particles) {
      draw.fillCircle(p.pos.x, p.pos.y, p.getRadius(), {
        color: CONFIG.COLOR,
        alpha: p.getAlpha(),
      });
    }
  }

  private spawnParticles(dt: number): void {
    if (!this.game) return;

    const velocity = V(this.boat.hull.body.velocity);
    const speed = velocity.magnitude;
    if (speed < CONFIG.MIN_SPEED) return;

    const speedFactor = clamp(
      invLerp(CONFIG.MIN_SPEED, CONFIG.MAX_SPEED, speed)
    );

    // Spawn rate scales with speed
    const spawnRate = CONFIG.SPAWN_RATE * speedFactor;
    this.spawnAccumulator += dt * spawnRate;

    const velDir = velocity.normalize();

    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;

      // Pick a random edge on the hull
      const hullVertices = this.boat.config.hull.vertices;
      const edgeIndex = Math.floor(Math.random() * hullVertices.length);
      const p1 = hullVertices[edgeIndex];
      const p2 = hullVertices[(edgeIndex + 1) % hullVertices.length];

      // Random point along this edge
      const localPos = lerpV2d(p1, p2, Math.random());

      // Calculate outward normal for this edge (perpendicular to edge, pointing out)
      const edge = p2.sub(p1);

      // Transform to world space
      const worldPos = this.boat.hull.body.toWorldFrame(localPos);
      const worldNormal = V(edge.y, -edge.x)
        .inormalize()
        .irotate(this.boat.hull.body.angle);

      // Only spawn if this edge is facing into the velocity (cutting through water)
      // We want edges where the outward normal aligns with velocity direction
      const facing = velDir.dot(worldNormal);

      // Skip edges not facing the velocity, with some randomness for variety
      if (facing < Math.random() * 0.3) continue;

      // Spray velocity: based on boat velocity plus outward spray
      const sprayOutward = worldNormal.mul(
        CONFIG.SPRAY_SPEED * rUniform(0.0, 2.0)
      );
      const particleVel = velocity.mul(rNormal(1, 0.1)).add(sprayOutward);
      const vz = CONFIG.INITIAL_VZ * rUniform(0.6, 1.2) * (0.5 + facing * 0.5);
      const size = rUniform(CONFIG.MIN_SIZE, CONFIG.MAX_SIZE);

      const particle = new SprayParticle(worldPos, particleVel, vz, size);
      this.particles.push(particle);
    }
  }
}
