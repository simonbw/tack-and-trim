import BaseEntity from "../../core/entity/BaseEntity";
import { V, V2d } from "../../core/Vector";
import type { Wind } from "../Wind";
import { WindModifier } from "../WindModifier";
import {
  calculateCamber,
  getSailLiftCoefficient,
  isSailStalled,
} from "./sail-helpers";
import type { Sail } from "./Sail";

// Wind effect constants
const WIND_INFLUENCE_SCALE = 0.15;
const WIND_MIN_DISTANCE = 5;
const STALL_TURBULENCE_SCALE = 15;

/**
 * Manages the wind modification effects produced by a sail.
 * When a sail generates lift, it creates circulation that affects nearby wind.
 * This enables emergent effects like:
 * - Slot effect (jib accelerates air for mainsail)
 * - Wind shadow (sails block wind from competitors)
 * - Stall turbulence (disturbed air downstream of stalled sails)
 */
export class SailWindEffect extends BaseEntity implements WindModifier {
  // Wind modifier state
  private windModifierPosition: V2d = V(0, 0);
  private windModifierNormal: V2d = V(0, 1);
  private currentLiftCoefficient: number = 0;
  private currentChordLength: number = 0;
  private currentWindSpeed: number = 0;
  private isStalled: boolean = false;

  constructor(private sail: Sail) {
    super();
  }

  onAdd() {
    // Register as wind modifier
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    wind?.registerModifier(this);
  }

  onDestroy() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    wind?.unregisterModifier(this);
  }

  onTick() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    // When sail is lowered, skip all calculations
    if (!this.sail.isHoisted()) {
      this.clearState();
      return;
    }

    this.updateState(wind);
  }

  private updateState(wind: Wind) {
    const head = this.sail.getHeadPosition();
    const clew = this.sail.getClewPosition();
    const bodies = this.sail.getBodies();

    // Chord from head to clew
    const chord = clew.sub(head);
    this.currentChordLength = chord.magnitude;

    // Normal perpendicular to chord
    const midParticle = bodies[Math.floor(bodies.length / 2)];
    const chordMidpoint = head.add(chord.mul(0.5));
    const billowDir = V(midParticle.position).sub(chordMidpoint);
    const chordNormal = chord.normalize().rotate90cw();
    this.windModifierNormal =
      billowDir.dot(chordNormal) > 0 ? chordNormal : chordNormal.mul(-1);

    // Position at sail centroid
    this.windModifierPosition = head.add(chord.mul(0.33));

    // Get base wind at sail position
    const baseWind = wind.getBaseVelocityAtPoint(this.windModifierPosition);
    this.currentWindSpeed = baseWind.magnitude;

    if (this.currentWindSpeed > 0.01 && this.currentChordLength > 0.01) {
      const windDir = baseWind.normalize();
      const chordDir = chord.normalize();
      const angleOfAttack = Math.acos(
        Math.max(-1, Math.min(1, windDir.dot(chordDir)))
      );

      const prevPos = V(bodies[Math.floor(bodies.length / 2) - 1].position);
      const nextPos = V(bodies[Math.floor(bodies.length / 2) + 1].position);
      const camber = calculateCamber(prevPos, V(midParticle.position), nextPos);

      this.currentLiftCoefficient = getSailLiftCoefficient(
        angleOfAttack,
        camber
      );
      this.isStalled = isSailStalled(angleOfAttack);
    } else {
      this.currentLiftCoefficient = 0;
      this.isStalled = false;
    }
  }

  private clearState(): void {
    this.currentLiftCoefficient = 0;
    this.currentChordLength = 0;
    this.currentWindSpeed = 0;
    this.isStalled = false;
  }

  // WindModifier interface

  getWindModifierPosition(): V2d {
    return this.windModifierPosition;
  }

  getWindModifierInfluenceRadius(): number {
    return this.sail.getWindInfluenceRadius();
  }

  getWindVelocityContribution(queryPoint: V2d): V2d {
    const influenceRadius = this.sail.getWindInfluenceRadius();
    const toQuery = queryPoint.sub(this.windModifierPosition);
    const r = toQuery.magnitude;

    if (r < WIND_MIN_DISTANCE || r > influenceRadius) {
      return V(0, 0);
    }

    const gamma =
      this.currentLiftCoefficient *
      this.currentChordLength *
      this.currentWindSpeed;

    const magnitude =
      (Math.abs(gamma) * WIND_INFLUENCE_SCALE) / Math.max(r, WIND_MIN_DISTANCE);

    const tangent = toQuery.normalize().rotate90ccw();
    let contribution = tangent.mul(magnitude * Math.sign(gamma));

    if (this.isStalled) {
      const turbulence = V(
        (Math.random() - 0.5) * STALL_TURBULENCE_SCALE,
        (Math.random() - 0.5) * STALL_TURBULENCE_SCALE
      );
      contribution = contribution.add(turbulence);
    }

    return contribution;
  }
}
