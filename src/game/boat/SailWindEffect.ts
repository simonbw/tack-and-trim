import BaseEntity from "../../core/entity/BaseEntity";
import { V, V2d } from "../../core/Vector";
import { TurbulenceParticle } from "../TurbulenceParticle";
import type { Wind } from "../Wind";
import { WindModifier } from "../WindModifier";
import { isSailStalled, STALL_ANGLE } from "./sail-helpers";
import type { Sail } from "./Sail";

// Wind effect constants
const WIND_MIN_DISTANCE = 5;

// Turbulence spawning configuration
const TURBULENCE_SPAWN_INTERVAL = 0.08; // seconds between spawns per segment
const TURBULENCE_INTENSITY = 15;
const TURBULENCE_MAX_AGE = 1.2;

// Zone-specific effect strengths
const LEEWARD_ACCELERATION = 0.12; // Accelerated parallel flow on leeward side
const WINDWARD_DECELERATION = 0.06; // Reduced flow on windward side
const WAKE_STRENGTH = 0.15; // Reduced flow in downwind wake

/**
 * Zones around a sail segment, relative to wind direction.
 */
const enum QueryZone {
  /** On the leeward (convex/billow) side - flow accelerates */
  Leeward,
  /** On the windward (concave) side - flow decelerates */
  Windward,
  /** Downwind of the segment - wake/shadow zone */
  Wake,
  /** Upwind of the segment - minimal effect */
  Upwind,
}

/**
 * Per-segment state for directional wind effects.
 * Each segment is an edge between adjacent sail nodes.
 */
export interface SailSegmentState {
  /** Segment midpoint in world coordinates */
  position: V2d;
  /** Unit normal pointing to leeward (convex/billow) side */
  normal: V2d;
  /** Unit tangent along segment (head toward clew) */
  tangent: V2d;
  /** Segment length */
  length: number;
  /** Local angle of attack */
  angleOfAttack: number;
  /** Whether this segment is stalled */
  isStalled: boolean;
}

/**
 * Manages the wind modification effects produced by a sail.
 * When a sail generates lift, it creates circulation that affects nearby wind.
 * This enables emergent effects like:
 * - Slot effect (jib accelerates air for mainsail)
 * - Wind shadow (sails block wind from competitors)
 * - Stall turbulence (disturbed air downstream of stalled sails)
 */
export class SailWindEffect extends BaseEntity implements WindModifier {
  // Per-segment state (computed each tick)
  private segments: SailSegmentState[] = [];

  // Aggregate state for quick checks
  private centroid: V2d = V(0, 0);
  private chordLength: number = 0;
  private windSpeed: number = 0;
  private windDirection: V2d = V(1, 0);

  // Turbulence spawning state (per-segment)
  private segmentSpawnTimers: number[] = [];

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

  onTick(dt: number) {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    // When sail is lowered, skip all calculations
    if (!this.sail.isHoisted()) {
      this.clearState();
      return;
    }

    this.updateState(wind);
    this.updateTurbulenceSpawning(wind, dt);
  }

  /**
   * Spawn turbulence particles from stalled segments.
   */
  private updateTurbulenceSpawning(wind: Wind, dt: number) {
    // Ensure spawn timer array matches segment count
    while (this.segmentSpawnTimers.length < this.segments.length) {
      this.segmentSpawnTimers.push(0);
    }

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];

      if (segment.isStalled) {
        // Decrement spawn timer
        this.segmentSpawnTimers[i] -= dt;

        if (this.segmentSpawnTimers[i] <= 0) {
          // Spawn turbulence particle
          this.spawnTurbulence(segment, wind);
          // Reset timer with some randomness to avoid synchronized spawns
          this.segmentSpawnTimers[i] =
            TURBULENCE_SPAWN_INTERVAL * (0.8 + Math.random() * 0.4);
        }
      } else {
        // Reset timer when not stalled
        this.segmentSpawnTimers[i] = 0;
      }
    }
  }

  /**
   * Spawn a turbulence particle from a stalled segment.
   */
  private spawnTurbulence(segment: SailSegmentState, wind: Wind) {
    // Spawn slightly downstream from the segment
    const windVel = wind.getBaseVelocityAtPoint(segment.position);
    const spawnOffset = this.windDirection.mul(segment.length * 0.5);
    const spawnPos = segment.position.add(spawnOffset);

    const particle = new TurbulenceParticle(spawnPos, windVel, {
      intensity: TURBULENCE_INTENSITY,
      maxAge: TURBULENCE_MAX_AGE,
    });

    this.game?.addEntity(particle);
  }

  private updateState(wind: Wind) {
    const head = this.sail.getHeadPosition();
    const clew = this.sail.getClewPosition();
    const bodies = this.sail.getBodies();

    // Chord from head to clew
    const chord = clew.sub(head);
    this.chordLength = chord.magnitude;

    // Centroid at 1/3 along chord (rough center of pressure)
    this.centroid = head.add(chord.mul(0.33));

    // Get base wind at centroid
    const baseWind = wind.getBaseVelocityAtPoint(this.centroid);
    this.windSpeed = baseWind.magnitude;
    if (this.windSpeed > 0.01) {
      this.windDirection = baseWind.normalize();
    }

    // Determine which side is leeward by looking at sail billow
    const midParticle = bodies[Math.floor(bodies.length / 2)];
    const chordMidpoint = head.add(chord.mul(0.5));
    const billowDir = V(midParticle.position).sub(chordMidpoint);
    const chordNormal = chord.normalize().rotate90cw();
    const leewardSign = billowDir.dot(chordNormal) > 0 ? 1 : -1;

    // Build per-segment state
    this.segments = [];
    for (let i = 0; i < bodies.length - 1; i++) {
      const p1 = V(bodies[i].position);
      const p2 = V(bodies[i + 1].position);

      const segment = p2.sub(p1);
      const segmentLength = segment.magnitude;
      if (segmentLength < 0.001) continue;

      const tangent = segment.normalize();
      // Normal points to leeward side (consistent with billow direction)
      const normal = tangent.rotate90cw().mul(leewardSign);
      const position = p1.add(segment.mul(0.5));

      // Calculate angle of attack for this segment
      let angleOfAttack = 0;
      if (this.windSpeed > 0.01) {
        // Angle between wind and segment tangent
        const dot = this.windDirection.dot(tangent);
        angleOfAttack = Math.acos(Math.max(-1, Math.min(1, dot)));
      }

      this.segments.push({
        position,
        normal,
        tangent,
        length: segmentLength,
        angleOfAttack,
        isStalled: isSailStalled(angleOfAttack),
      });
    }
  }

  private clearState(): void {
    this.segments = [];
    this.segmentSpawnTimers = [];
    this.chordLength = 0;
    this.windSpeed = 0;
  }

  // WindModifier interface

  getWindModifierPosition(): V2d {
    return this.centroid;
  }

  getWindModifierInfluenceRadius(): number {
    return this.sail.getWindInfluenceRadius();
  }

  getWindVelocityContribution(queryPoint: V2d): V2d {
    if (this.segments.length === 0 || this.windSpeed < 0.01) {
      return V(0, 0);
    }

    const influenceRadius = this.sail.getWindInfluenceRadius();
    const contribution = V(0, 0);

    // Sum contributions from all segments
    for (const segment of this.segments) {
      const toQuery = queryPoint.sub(segment.position);
      const distance = toQuery.magnitude;

      // Skip segments too close or too far
      if (distance < WIND_MIN_DISTANCE || distance > influenceRadius) {
        continue;
      }

      // Get contribution for this segment
      const segmentContribution = this.getSegmentContribution(
        segment,
        toQuery,
        distance
      );
      contribution.iadd(segmentContribution);
    }

    // Note: Stalled segment turbulence is now handled by TurbulenceParticle entities
    // which are spawned in updateTurbulenceSpawning()

    return contribution;
  }

  /**
   * Classify which zone a query point is in relative to a segment.
   */
  private classifyZone(
    segment: SailSegmentState,
    toQuery: V2d
  ): QueryZone {
    // Cross-wind vs along-wind position
    const normalComponent = toQuery.dot(segment.normal);
    const alongWind = toQuery.dot(this.windDirection);

    // If clearly on one side of the segment (across the wind)
    if (Math.abs(normalComponent) > Math.abs(alongWind) * 0.5) {
      return normalComponent > 0 ? QueryZone.Leeward : QueryZone.Windward;
    }

    // If along the wind direction (upwind or downwind)
    return alongWind > 0 ? QueryZone.Wake : QueryZone.Upwind;
  }

  /**
   * Calculate wind velocity contribution from a single segment.
   * Different zones get different effects based on sail aerodynamics.
   */
  private getSegmentContribution(
    segment: SailSegmentState,
    toQuery: V2d,
    distance: number
  ): V2d {
    // Stalled segments produce no organized flow (will spawn turbulence instead)
    if (segment.isStalled) {
      return V(0, 0);
    }

    // Base strength depends on angle of attack and segment size
    const effectiveAlpha = Math.min(segment.angleOfAttack, STALL_ANGLE);
    const baseStrength =
      Math.sin(effectiveAlpha) * segment.length * this.windSpeed;

    // Falloff with distance (1/r)
    const falloff = 1 / Math.max(distance, WIND_MIN_DISTANCE);

    // Classify the query point's zone
    const zone = this.classifyZone(segment, toQuery);

    switch (zone) {
      case QueryZone.Leeward: {
        // Leeward: Flow accelerates parallel to the surface
        // Add velocity in the wind direction
        const magnitude = baseStrength * LEEWARD_ACCELERATION * falloff;
        return this.windDirection.mul(magnitude);
      }

      case QueryZone.Windward: {
        // Windward: Flow is blocked/decelerated
        // Reduce velocity in wind direction (negative contribution)
        const magnitude = baseStrength * WINDWARD_DECELERATION * falloff;
        return this.windDirection.mul(-magnitude);
      }

      case QueryZone.Wake: {
        // Wake: Wind shadow behind the sail
        // Reduce velocity significantly in wind direction
        const magnitude = baseStrength * WAKE_STRENGTH * falloff;
        return this.windDirection.mul(-magnitude);
      }

      case QueryZone.Upwind: {
        // Upwind: Minimal effect (flow hasn't reached the sail yet)
        return V(0, 0);
      }
    }
  }

  /** Get segment states for debugging/visualization. */
  getSegments(): readonly SailSegmentState[] {
    return this.segments;
  }
}
