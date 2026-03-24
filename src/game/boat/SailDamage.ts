import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import type { Boat } from "./Boat";
import type { SailDamageConfig } from "./BoatConfig";
import type { Sail } from "./sail/Sail";
import type { Sheet } from "./Sheet";

/**
 * Tracks sail damage from overpowering and jibes.
 *
 * Each sail (main/jib) gets its own SailDamage instance.
 * Health goes from 1.0 (pristine) to 0.0 (destroyed). Damage effects:
 * - Reduced lift (drive force), pulled by Sail via getDamageMultiplier
 *
 * Damage sources:
 * - Overpowering: sustained reaction forces above threshold cause gradual wear
 * - Jibes: boom slam (mainsheet going taut with high force) causes instant damage
 */
export class SailDamage extends BaseEntity {
  private health: number = 1.0;
  private readonly config: SailDamageConfig;
  private readonly boat: Boat;
  private readonly sail: Sail;
  private readonly sailName: "main" | "jib";

  /** Sheet to monitor for jibe detection (mainsheet for main, active jib sheet for jib) */
  private readonly sheet: Sheet | null;

  /** Track sheet constraint state for jibe detection (same pattern as BoatSoundGenerator) */
  private wasSheetActive: boolean = false;

  constructor(
    boat: Boat,
    config: SailDamageConfig,
    sail: Sail,
    sailName: "main" | "jib",
    sheet: Sheet | null,
  ) {
    super();
    this.boat = boat;
    this.config = config;
    this.sail = sail;
    this.sailName = sailName;
    this.sheet = sheet;
  }

  getDamage(): number {
    return 1 - this.health;
  }

  getHealth(): number {
    return this.health;
  }

  /** Lift multiplier for the sail (1.0 = full lift) */
  getLiftMultiplier(): number {
    return 1 - this.config.maxLiftReduction * this.getDamage();
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    // Natural repair
    if (this.config.repairRate > 0 && this.health < 1) {
      this.health = clamp(this.health + this.config.repairRate * dt, 0, 1);
    }

    if (this.health <= 0) return;

    // --- Overpowering damage ---
    const reactionForce = this.sail.getTotalReactionForce();
    const excessForce = reactionForce - this.config.overpowerForceThreshold;
    if (excessForce > 0) {
      const damage = this.config.overpowerDamageRate * excessForce * dt;
      this.takeDamage(damage, "overpower");
    }

    // --- Jibe damage (detect sheet going taut with high force) ---
    if (this.sheet) {
      this.checkJibeDamage();
    }
  }

  private checkJibeDamage(): void {
    const constraint = this.sheet!.constraints?.[0];
    if (!constraint) return;

    const equation = constraint.equations[0];
    if (!equation) return;

    const isActive = equation.enabled;
    const force = Math.abs(equation.multiplier);

    // Detect transition from slack to taut with significant force
    if (isActive && !this.wasSheetActive && force > 0) {
      const damage = this.config.jibeDamagePerForce * force;
      if (damage > 0.001) {
        this.takeDamage(damage, "jibe");
      }
    }

    this.wasSheetActive = isActive;
  }

  private takeDamage(amount: number, source: "overpower" | "jibe"): void {
    const prevHealth = this.health;
    this.health = clamp(this.health - amount, 0, 1);

    if (this.health < prevHealth) {
      this.game.dispatch("sailDamaged", {
        damage: amount,
        health: this.health,
        sail: this.sailName,
        source,
      });
    }
  }
}
