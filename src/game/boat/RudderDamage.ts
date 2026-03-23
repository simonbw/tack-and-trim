import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import type { Boat } from "./Boat";
import type { RudderDamageConfig } from "./BoatConfig";

/**
 * Tracks rudder damage from groundings.
 *
 * Health goes from 1.0 (pristine) to 0.0 (destroyed). Damage effects:
 * - Reduced steering authority (lift force multiplier, pulled by Rudder)
 * - Steering bias pulling to one side (random direction, locked on first damage)
 */
export class RudderDamage extends BaseEntity {
  private health: number = 1.0;
  private readonly config: RudderDamageConfig;
  private readonly boat: Boat;

  /** Direction of steering bias: -1 or 1, chosen randomly on first damage */
  private biasDirection: number = 0;

  constructor(boat: Boat, config: RudderDamageConfig) {
    super();
    this.boat = boat;
    this.config = config;
  }

  getDamage(): number {
    return 1 - this.health;
  }

  getHealth(): number {
    return this.health;
  }

  /** Multiplier for rudder lift forces (1.0 = full authority) */
  getSteeringMultiplier(): number {
    return 1 - this.config.maxSteeringReduction * this.getDamage();
  }

  /** Steering bias in steer units (-1 to 1 range), pulls rudder to one side */
  getSteeringBias(): number {
    return this.biasDirection * this.config.maxSteeringBias * this.getDamage();
  }

  /**
   * Apply damage from a grounding event.
   * Called by BoatGrounding each tick while rudder is in contact with terrain.
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
      // Lock in bias direction on first damage
      if (this.biasDirection === 0) {
        this.biasDirection = Math.random() < 0.5 ? -1 : 1;
      }

      this.game.dispatch("rudderDamaged", {
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
}
