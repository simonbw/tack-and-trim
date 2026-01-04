import { Graphics } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../core/entity/GameSprite";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";

interface WaterParticle {
  pos: V2d;
  age: number;
}

// Particle behavior
const MAX_AGE = 3.0;
const SPAWN_RATE = 40; // particles per second
const SPAWN_RADIUS = 300; // spawn area around boat
const COLOR = 0xaaddff;
const MAX_ALPHA = 0.5;

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
      if (p.age >= MAX_AGE) return false;
      const dist = p.pos.distanceTo(boatPos);
      return dist < SPAWN_RADIUS * 1.5;
    });

    // Spawn new particles
    this.spawnAccumulator += dt * SPAWN_RATE;
    while (this.spawnAccumulator >= 1) {
      this.spawnAccumulator -= 1;
      this.spawnParticle();
    }
  }

  private spawnParticle() {
    const boatPos = this.boat.getPosition();

    // Random position in circle around boat
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * SPAWN_RADIUS;
    const offset = V(Math.cos(angle) * radius, Math.sin(angle) * radius);

    this.particles.push({
      pos: boatPos.add(offset),
      age: 0,
    });
  }

  onRender() {
    this.graphics.clear();

    for (const p of this.particles) {
      const t = p.age / MAX_AGE;
      const phase = Math.sin(t * Math.PI) * MAX_ALPHA;

      this.graphics
        .circle(p.pos.x, p.pos.y, 1.5)
        .fill({ color: COLOR, alpha: phase });
    }
  }
}
