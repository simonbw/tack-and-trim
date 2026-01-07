import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { clamp, lerp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Boat } from "../boat/Boat";
import { WakeParticle } from "./WakeParticle";

interface WakePoint {
  leftPos: V2d;
  rightPos: V2d;
  perpendicular: V2d;
  age: number;
  speed: number;
}

const CONFIG = {
  MAX_AGE: 3.0,
  SPAWN_DISTANCE: 8, // Spawn particles every N units of distance traveled
  MIN_SPEED: 5,
  MAX_SPEED: 55,
  REAR_OFFSET: -18,
  INITIAL_SPREAD: 6,
  SPREAD_RATE: 15,
  COLOR: 0xffffff,
  MIN_ALPHA: 0.2,
  MAX_ALPHA: 0.7,
  MIN_LINE_WIDTH: 1,
  MAX_LINE_WIDTH: 3,
  // Wake particle lifespan range for natural variation
  MIN_PARTICLE_LIFESPAN: 2.0,
  MAX_PARTICLE_LIFESPAN: 5.0,
};

export class Wake extends BaseEntity {
  private graphics: GameSprite & Graphics;
  private wakePoints: WakePoint[] = [];
  private lastSpawnPos: V2d | null = null;

  constructor(private boat: Boat) {
    super();
    this.graphics = createGraphics("wake");
    this.sprite = this.graphics;
  }

  onTick(dt: number) {
    this.updatePoints(dt);
    this.maybeSpawnPoint();
    this.wakePoints = this.wakePoints.filter((p) => p.age < CONFIG.MAX_AGE);
  }

  private updatePoints(dt: number) {
    for (const point of this.wakePoints) {
      point.age += dt;
      const spreadAmount = CONFIG.SPREAD_RATE * dt;
      point.leftPos.iaddScaled(point.perpendicular, spreadAmount);
      point.rightPos.iaddScaled(point.perpendicular, -spreadAmount);
    }
  }

  private maybeSpawnPoint() {
    const velocity = V(this.boat.hull.body.velocity);
    const speed = velocity.magnitude;

    if (speed < CONFIG.MIN_SPEED) return;

    const boatPos = this.boat.getPosition();

    // Check distance traveled since last spawn
    if (this.lastSpawnPos) {
      const dx = boatPos.x - this.lastSpawnPos.x;
      const dy = boatPos.y - this.lastSpawnPos.y;
      const distSquared = dx * dx + dy * dy;
      if (distSquared < CONFIG.SPAWN_DISTANCE * CONFIG.SPAWN_DISTANCE) return;
    }
    this.lastSpawnPos = boatPos.clone();

    const speedFactor = clamp(
      (speed - CONFIG.MIN_SPEED) / (CONFIG.MAX_SPEED - CONFIG.MIN_SPEED)
    );
    const boatAngle = this.boat.hull.body.angle;

    const rearOffset = V(CONFIG.REAR_OFFSET, 0).rotate(boatAngle);
    const rearPos = boatPos.add(rearOffset);
    const perpendicular = V(0, 1).rotate(boatAngle);

    // Spawn visual wake points
    this.wakePoints.push({
      leftPos: rearPos.add(perpendicular.mul(CONFIG.INITIAL_SPREAD)),
      rightPos: rearPos.add(perpendicular.mul(-CONFIG.INITIAL_SPREAD)),
      perpendicular: perpendicular.clone(),
      age: 0,
      speed,
    });

    // Spawn physics wake particles as entities
    // Wake velocity is outward from the boat's path, scaled by boat speed
    const wakeSpeed = speed * 0.3; // Wake moves slower than boat
    const leftVelocity = perpendicular.mul(wakeSpeed);
    const rightVelocity = perpendicular.mul(-wakeSpeed);

    // Random lifespan for natural variation
    const lifespanRange =
      CONFIG.MAX_PARTICLE_LIFESPAN - CONFIG.MIN_PARTICLE_LIFESPAN;
    const leftLifespan =
      CONFIG.MIN_PARTICLE_LIFESPAN + Math.random() * lifespanRange;
    const rightLifespan =
      CONFIG.MIN_PARTICLE_LIFESPAN + Math.random() * lifespanRange;

    this.game?.addEntity(
      new WakeParticle(
        rearPos.add(perpendicular.mul(CONFIG.INITIAL_SPREAD)),
        leftVelocity,
        speedFactor,
        leftLifespan
      )
    );
    this.game?.addEntity(
      new WakeParticle(
        rearPos.add(perpendicular.mul(-CONFIG.INITIAL_SPREAD)),
        rightVelocity,
        speedFactor,
        rightLifespan
      )
    );
  }

  onRender() {
    // Disabled - using shader-based height coloring instead
    this.graphics.clear();
  }

  private drawTrail(points: Array<{ pos: V2d; age: number; speed: number }>) {
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      const ageFactor = 1 - curr.age / CONFIG.MAX_AGE;
      const speedFactor = clamp(
        (curr.speed - CONFIG.MIN_SPEED) / (CONFIG.MAX_SPEED - CONFIG.MIN_SPEED)
      );
      const alpha =
        ageFactor * lerp(CONFIG.MIN_ALPHA, CONFIG.MAX_ALPHA, speedFactor);

      if (alpha <= 0.01) continue;

      const lineWidth =
        lerp(CONFIG.MIN_LINE_WIDTH, CONFIG.MAX_LINE_WIDTH, speedFactor) *
        ageFactor;

      this.graphics
        .moveTo(prev.pos.x, prev.pos.y)
        .lineTo(curr.pos.x, curr.pos.y)
        .stroke({ color: CONFIG.COLOR, width: lineWidth, alpha });
    }
  }
}
