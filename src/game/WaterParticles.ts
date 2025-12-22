import { Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../core/entity/GameSprite";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";

interface WaterParticle {
  pos: V2d;
  age: number;
}

const CONFIG = {
  // Particle behavior
  MAX_AGE: 3.0,
  SPAWN_RATE: 40, // particles per second
  SPAWN_RADIUS: 300, // spawn area around boat

  // Visual
  STREAK_LENGTH: 0.15, // multiplier of boat speed
  MIN_STREAK: 2,
  MAX_STREAK: 15,
  COLOR: 0xaaddff,
  MIN_ALPHA: 0.15,
  MAX_ALPHA: 0.5,
  LINE_WIDTH: 1.5,
};

export class WaterParticles extends BaseEntity {
  private graphics: GameSprite & Graphics;
  private particles: WaterParticle[] = [];
  private spawnAccumulator = 0;

  constructor(private boat: Boat) {
    super();
    this.graphics = createGraphics("wake");
    this.sprite = this.graphics;
  }

  onTick(dt: number) {
    // Particles are stationary in water - just age them
    for (const p of this.particles) {
      p.age += dt;
    }

    // Remove old particles or ones too far from boat
    const boatPos = this.boat.getPosition();
    this.particles = this.particles.filter((p) => {
      if (p.age >= CONFIG.MAX_AGE) return false;
      const dist = p.pos.sub(boatPos).magnitude;
      return dist < CONFIG.SPAWN_RADIUS * 1.5;
    });

    // Spawn new particles
    this.spawnAccumulator += dt * CONFIG.SPAWN_RATE;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      this.spawnParticle();
    }
  }

  private spawnParticle() {
    const boatPos = this.boat.getPosition();

    // Random position in circle around boat
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * CONFIG.SPAWN_RADIUS;
    const offset = V(Math.cos(angle) * radius, Math.sin(angle) * radius);

    this.particles.push({
      pos: boatPos.add(offset),
      age: 0,
    });
  }

  onRender() {
    this.graphics.clear();

    // Water velocity (currents not implemented yet, so just 0)
    const waterVelocity = V(0, 0);
    const waterSpeed = waterVelocity.magnitude;

    for (const p of this.particles) {
      const ageFactor = 1 - p.age / CONFIG.MAX_AGE;
      const alpha =
        CONFIG.MIN_ALPHA + ageFactor * (CONFIG.MAX_ALPHA - CONFIG.MIN_ALPHA);
      if (alpha <= 0.01) continue;

      if (waterSpeed < 1) {
        // Draw dots when water is still
        this.graphics
          .circle(p.pos.x, p.pos.y, 1.5)
          .fill({ color: CONFIG.COLOR, alpha });
      } else {
        // Draw streaks based on water velocity
        const streakLength = Math.min(
          CONFIG.MAX_STREAK,
          Math.max(CONFIG.MIN_STREAK, waterSpeed * CONFIG.STREAK_LENGTH)
        );
        const streakOffset = waterVelocity.normalize().mul(streakLength);
        const end = p.pos.add(streakOffset);

        this.graphics
          .moveTo(p.pos.x, p.pos.y)
          .lineTo(end.x, end.y)
          .stroke({ color: CONFIG.COLOR, width: CONFIG.LINE_WIDTH, alpha });
      }
    }
  }
}
