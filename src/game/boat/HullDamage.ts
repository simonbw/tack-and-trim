import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { clamp } from "../../core/util/MathUtil";
import { rUniform } from "../../core/util/Random";
import { V } from "../../core/Vector";
import type { Boat } from "./Boat";
import type { HullDamageConfig } from "./BoatConfig";

const MAX_SCRATCHES = 20;
const SCRATCH_COLOR = 0x443322;

interface Scratch {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z: number;
  width: number;
  severity: number;
}

/**
 * Tracks hull damage from groundings and collisions.
 *
 * Health goes from 1.0 (pristine) to 0.0 (destroyed). Damage effects:
 * - Increased skin friction (pulled by Hull via getSkinFrictionMultiplier)
 * - Water ingress through hull (pulled by Bilge via getLeakRate)
 * - Visual scratch marks on the hull
 */
export class HullDamage extends BaseEntity {
  layer = "boat" as const;

  private health: number = 1.0;
  private scratches: Scratch[] = [];
  private readonly config: HullDamageConfig;
  private readonly boat: Boat;

  constructor(boat: Boat, config: HullDamageConfig) {
    super();
    this.boat = boat;
    this.config = config;
  }

  /** Get current damage level (0 = pristine, 1 = destroyed) */
  getDamage(): number {
    return 1 - this.health;
  }

  /** Get current health (1 = pristine, 0 = destroyed) */
  getHealth(): number {
    return this.health;
  }

  /** Set health directly, clamped to [0, 1]. Clears scratch marks. */
  setHealth(value: number): void {
    this.health = clamp(value, 0, 1);
    this.scratches = [];
  }

  /** Effective skin friction multiplier based on damage */
  getSkinFrictionMultiplier(): number {
    return 1 + this.config.damageFrictionMultiplier * this.getDamage();
  }

  /** Current hull leak rate in cubic ft/s */
  getLeakRate(): number {
    return this.config.damageLeakRate * this.getDamage();
  }

  /**
   * Apply damage from a grounding event.
   * Called by BoatGrounding each tick while hull/keel is in contact with terrain.
   */
  applyGroundingDamage(penetration: number, speed: number, dt: number): void {
    if (speed < this.config.groundingSpeedThreshold) return;
    if (this.health <= 0) return;

    const effectiveSpeed = speed - this.config.groundingSpeedThreshold;
    const damage =
      this.config.groundingDamageRate * penetration * effectiveSpeed * dt;

    if (damage > 0) {
      this.takeDamage(damage, "grounding");
    }
  }

  private takeDamage(amount: number, source: "grounding"): void {
    const prevHealth = this.health;
    this.health = clamp(this.health - amount, 0, 1);

    if (this.health < prevHealth) {
      this.addScratch(amount);
      this.game.dispatch("hullDamaged", {
        damage: amount,
        health: this.health,
        source,
      });
    }
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    if (this.config.repairRate > 0 && this.health < 1) {
      this.health = clamp(this.health + this.config.repairRate * dt, 0, 1);
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    if (this.scratches.length === 0) return;

    const [x, y] = this.boat.hull.body.position;
    const t = this.boat.hull.tiltTransform;

    draw.at({ pos: V(x, y), angle: this.boat.hull.body.angle }, () => {
      for (const scratch of this.scratches) {
        const alpha = scratch.severity * 0.7;
        const sx1 = scratch.x1 + scratch.z * t.sinPitch;
        const sy1 = scratch.y1 * t.cosRoll + scratch.z * t.sinRoll;
        const sx2 = scratch.x2 + scratch.z * t.sinPitch;
        const sy2 = scratch.y2 * t.cosRoll + scratch.z * t.sinRoll;
        draw.line(sx1, sy1, sx2, sy2, {
          color: SCRATCH_COLOR,
          width: scratch.width,
          alpha,
          z: scratch.z,
        });
      }
    });
  }

  private addScratch(damage: number): void {
    if (this.scratches.length >= MAX_SCRATCHES) {
      this.scratches.shift();
    }

    const verts = this.boat.config.hull.vertices;
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    for (const v of verts) {
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }

    // Random position within hull bounds (shrunk slightly to stay inside)
    const cx = rUniform(minX * 0.8, maxX * 0.8);
    const cy = rUniform(minY * 0.6, maxY * 0.6);
    const angle = rUniform(0, Math.PI);
    const length = rUniform(0.5, 2.0);
    const halfLen = length / 2;

    this.scratches.push({
      x1: cx - Math.cos(angle) * halfLen,
      y1: cy - Math.sin(angle) * halfLen,
      x2: cx + Math.cos(angle) * halfLen,
      y2: cy + Math.sin(angle) * halfLen,
      z: this.boat.config.hull.deckHeight,
      width: clamp(damage * 20, 0.08, 0.25),
      severity: clamp(damage * 5, 0.3, 1.0),
    });
  }
}
