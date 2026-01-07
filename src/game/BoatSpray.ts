import { Graphics, Sprite, Texture } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { createEmptySprite } from "../core/entity/GameSprite";
import Game from "../core/Game";
import { clamp, invLerp, lerp, lerpV2d } from "../core/util/MathUtil";
import { rNormal, rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";

// Hull outline points (from Hull.ts) for spawning along the perimeter
const HULL_POINTS: V2d[] = [
  V(-20, -4),
  V(-18, -7),
  V(-8, -10),
  V(6, -10),
  V(16, -8),
  V(24, -4),
  V(28, 0), // Bow
  V(24, 4),
  V(16, 8),
  V(6, 10),
  V(-8, 10),
  V(-18, 7),
  V(-20, 4),
];

const CONFIG = {
  // Particle lifecycle
  MAX_AGE: 0.6,

  // Speed thresholds
  MIN_SPEED: 10,
  MAX_SPEED: 55,

  // Spawning
  SPAWN_RATE: 5, // Base particles per second at max speed

  // Physics
  SPRAY_SPEED: 12, // How fast particles spray outward from hull
  INITIAL_VZ: 30, // Initial upward velocity
  GRAVITY: 120,
  DRAG: 2.0, // Velocity decay rate per second

  // Rendering
  COLOR: 0xffffff,
  MIN_ALPHA: 0.7,
  MAX_ALPHA: 1.0,
  MIN_SIZE: 1.4,
  MAX_SIZE: 2.0,
  TEXTURE_SIZE: 8, // Texture resolution in pixels

  // Splash (when hitting water)
  SPLASH_DURATION: 0.3,
  SPLASH_GROW_SCALE: 2.0, // How much bigger the splash grows
};

// Cached particle texture
let _particleTexture: Texture | null = null;
function getParticleTexture(game: Game): Texture {
  if (!_particleTexture) {
    const g = new Graphics();
    g.circle(
      CONFIG.TEXTURE_SIZE / 2,
      CONFIG.TEXTURE_SIZE / 2,
      CONFIG.TEXTURE_SIZE / 2
    );
    g.fill({ color: 0xffffff });
    _particleTexture = game.renderer.app.renderer.generateTexture(g);
  }
  return _particleTexture;
}

/**
 * A single spray particle entity with position, velocity, and sprite.
 */
class SprayParticle extends BaseEntity {
  pos: V2d;
  vel: V2d;
  z: number; // Height above water
  vz: number; // Vertical velocity
  age: number = 0;
  size: number;

  // Splash state (when particle hits water)
  splashing: boolean = false;
  splashAge: number = 0;

  // Named particleSprite to avoid auto-adding to world
  readonly particleSprite: Sprite;

  constructor(pos: V2d, vel: V2d, vz: number, size: number, texture: Texture) {
    super();
    this.pos = pos;
    this.vel = vel;
    this.z = 0.1;
    this.vz = vz;
    this.size = size;

    this.particleSprite = new Sprite(texture);
    this.particleSprite.anchor.set(0.5, 0.5);
    this.particleSprite.tint = CONFIG.COLOR;
    this.particleSprite.position.copyFrom(this.pos);
  }

  onTick(dt: number): void {
    if (this.splashing) {
      // Splash phase: grow and fade, then destroy
      this.splashAge += dt;
      if (this.splashAge >= CONFIG.SPLASH_DURATION) {
        this.destroy();
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
      } else if (this.age >= CONFIG.MAX_AGE) {
        this.destroy();
      }
    }
  }

  onRender(): void {
    this.particleSprite.position.copyFrom(this.pos);

    if (this.splashing) {
      // Splash: grow and fade out
      const t = this.splashAge / CONFIG.SPLASH_DURATION;
      const alpha = CONFIG.MIN_ALPHA * (1 - t);
      const scale =
        (this.size * lerp(1, CONFIG.SPLASH_GROW_SCALE, t)) /
        CONFIG.TEXTURE_SIZE;

      this.particleSprite.alpha = alpha;
      this.particleSprite.scale.set(scale);
    } else {
      // Flying: normal rendering
      const ageFactor = 1 - this.age / CONFIG.MAX_AGE;
      const heightFactor = Math.min(this.z / 8, 1);
      const alpha =
        lerp(CONFIG.MIN_ALPHA, CONFIG.MAX_ALPHA, ageFactor) * heightFactor;

      this.particleSprite.alpha = alpha;

      const visualSize =
        this.size * (1 + this.z * 0.02) * (0.6 + 0.4 * ageFactor);
      const scale = visualSize / CONFIG.TEXTURE_SIZE;
      this.particleSprite.scale.set(scale);
    }
  }

  onDestroy(): void {
    this.particleSprite.destroy();
  }
}

export class BoatSpray extends BaseEntity {
  private spawnAccumulator = 0;
  sprite: NonNullable<BaseEntity["sprite"]>;

  constructor(private boat: Boat) {
    super();
    this.sprite = createEmptySprite("wake");
  }

  onTick(dt: number): void {
    this.spawnParticles(dt);
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
    const texture = getParticleTexture(this.game);

    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;

      // Pick a random edge on the hull
      const edgeIndex = Math.floor(Math.random() * HULL_POINTS.length);
      const p1 = HULL_POINTS[edgeIndex];
      const p2 = HULL_POINTS[(edgeIndex + 1) % HULL_POINTS.length];

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

      const particle = new SprayParticle(
        worldPos,
        particleVel,
        vz,
        size,
        texture
      );

      // Add as child entity and add sprite to our container
      this.addChild(particle);
      this.sprite.addChild(particle.particleSprite);
    }
  }
}
