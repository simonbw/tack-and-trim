import BaseEntity from "../../core/entity/BaseEntity";
import { profiler } from "../../core/util/Profiler";
import { AABB } from "../../core/util/SparseSpatialHash";
import { V, V2d } from "../../core/Vector";
import { TurbulenceParticle } from "../TurbulenceParticle";
import type { Wind } from "../Wind";
import { WindModifier } from "../WindModifier";
import {
  calculateCamber,
  getSailLiftCoefficient,
  isSailStalled,
} from "./sail-helpers";
import type { Sail } from "./Sail";

// Units: feet (ft), seconds
// Wind effect constants
const WIND_MIN_DISTANCE = 1.5; // ft - minimum distance for wind effect

// Directional wind effect constants (dimensionless)
const LEEWARD_ACCELERATION = 0.15; // Flow speedup on leeward side
const WINDWARD_BLOCKAGE = 0.1; // Flow reduction on windward side
const WAKE_SHADOW_FACTOR = 0.2; // Wind reduction in wake
const WAKE_LENGTH_FACTOR = 3.0; // How far wake extends (× segment length)

// Turbulence spawning constants
const TURBULENCE_SPAWN_INTERVAL = 0.1; // seconds - min time between spawns per segment
const TURBULENCE_SPAWN_OFFSET = 1.5; // ft - distance downwind to spawn particle
const MAX_TURBULENCE_PARTICLES = 30; // Global cap on active turbulence particles

/**
 * State for a single sail segment (edge between adjacent particles).
 */
export interface SailSegmentState {
  position: V2d; // Segment midpoint
  normal: V2d; // Perpendicular to segment, pointing to leeward side
  tangent: V2d; // Along segment direction (head to clew)
  length: number; // Segment length
  liftCoefficient: number; // Local Cl
  isStalled: boolean; // Local stall state
  camber: number; // Local curvature
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
  tags = ["windModifier"];

  // Per-segment state (kept for turbulence spawning only)
  private segmentStates: SailSegmentState[] = [];

  // Stall tracking for turbulence spawning
  private prevSegmentStalled: boolean[] = [];
  private lastSpawnTime: number[] = [];

  // Pre-computed aggregate state for O(1) wind contribution
  private centroid: V2d = V(0, 0);
  private chordDirection: V2d = V(1, 0);
  private chordLength: number = 0;
  private averageNormal: V2d = V(0, 1);
  private averageLiftCoefficient: number = 0;
  private stallFraction: number = 0;
  private windSpeed: number = 0;
  private windDirection: V2d = V(1, 0);

  // Reusable AABB to avoid allocations
  private readonly aabb: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(private sail: Sail) {
    super();
  }

  onTick() {
    profiler.start("sail-wind-effect-tick");
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) {
      profiler.end("sail-wind-effect-tick");
      return;
    }

    // When sail is lowered, skip all calculations
    if (!this.sail.isHoisted()) {
      this.clearState();
      profiler.end("sail-wind-effect-tick");
      return;
    }

    this.updateState(wind);
    this.handleStallTransitions(wind);
    profiler.end("sail-wind-effect-tick");
  }

  private updateState(wind: Wind) {
    const head = this.sail.getHeadPosition();
    const clew = this.sail.getClewPosition();
    const bodies = this.sail.getBodies();

    // Chord geometry
    const chord = clew.sub(head);
    this.chordLength = chord.magnitude;
    this.chordDirection =
      this.chordLength > 0.01 ? chord.mul(1 / this.chordLength) : V(1, 0);

    // Centroid at 1/3 along chord (toward head)
    this.centroid = head.add(chord.mul(0.33));

    // Get base wind at sail position
    const baseWind = wind.getBaseVelocityAtPoint(this.centroid);
    this.windSpeed = baseWind.magnitude;
    this.windDirection = this.windSpeed > 0.01 ? baseWind.normalize() : V(1, 0);

    // Determine overall leeward direction from middle of sail
    const midParticle = bodies[Math.floor(bodies.length / 2)];
    const chordMidpoint = head.add(chord.mul(0.5));
    const billowDir = V(midParticle.position).sub(chordMidpoint);
    const chordNormal = this.chordDirection.rotate90cw();
    const leewardSign = billowDir.dot(chordNormal) > 0 ? 1 : -1;
    this.averageNormal = chordNormal.mul(leewardSign);

    // Compute per-segment state (for turbulence spawning)
    const numSegments = bodies.length - 1;
    if (this.segmentStates.length !== numSegments) {
      this.segmentStates = new Array(numSegments);
    }

    // Accumulators for aggregate stats
    let totalLiftCoefficient = 0;
    let totalLength = 0;
    let stalledLength = 0;

    for (let i = 0; i < numSegments; i++) {
      const p0 = i === 0 ? head : V(bodies[i].position);
      const p1 = V(bodies[i + 1].position);
      const p2 = i + 2 < bodies.length ? V(bodies[i + 2].position) : clew;

      // Segment midpoint
      const position = p0.add(p1).mul(0.5);

      // Segment tangent and length
      const segmentVec = p1.sub(p0);
      const length = segmentVec.magnitude;
      const tangent = length > 0.001 ? segmentVec.mul(1 / length) : V(1, 0);

      // Normal pointing to leeward side
      const rawNormal = tangent.rotate90cw();
      const normal = rawNormal.mul(leewardSign);

      // Local camber from 3-point geometry
      const camber = calculateCamber(p0, p1, p2);

      // Local aerodynamic state
      let liftCoefficient = 0;
      let isStalled = false;

      if (this.windSpeed > 0.01 && length > 0.01) {
        const angleOfAttack = Math.acos(
          Math.max(-1, Math.min(1, this.windDirection.dot(tangent)))
        );
        liftCoefficient = getSailLiftCoefficient(angleOfAttack, camber);
        isStalled = isSailStalled(angleOfAttack);
      }

      this.segmentStates[i] = {
        position,
        normal,
        tangent,
        length,
        liftCoefficient,
        isStalled,
        camber,
      };

      // Accumulate for aggregates (weighted by segment length)
      totalLiftCoefficient += liftCoefficient * length;
      totalLength += length;
      if (isStalled) {
        stalledLength += length;
      }
    }

    // Compute final aggregate values
    if (totalLength > 0.01) {
      this.averageLiftCoefficient = totalLiftCoefficient / totalLength;
      this.stallFraction = stalledLength / totalLength;
    } else {
      this.averageLiftCoefficient = 0;
      this.stallFraction = 0;
    }
  }

  private clearState(): void {
    this.chordLength = 0;
    this.windSpeed = 0;
    this.averageLiftCoefficient = 0;
    this.stallFraction = 0;
    this.segmentStates = [];
    this.prevSegmentStalled = [];
    this.lastSpawnTime = [];
  }

  /**
   * Check for stall transitions and spawn turbulence particles.
   */
  private handleStallTransitions(wind: Wind): void {
    const currentTime = this.game?.elapsedUnpausedTime ?? 0;
    const numSegments = this.segmentStates.length;

    // Initialize tracking arrays if needed
    if (this.prevSegmentStalled.length !== numSegments) {
      this.prevSegmentStalled = new Array(numSegments).fill(false);
      this.lastSpawnTime = new Array(numSegments).fill(0);
    }

    // Count active turbulence particles globally
    const activeTurbulence =
      this.game?.entities.getTagged("turbulence").length ?? 0;

    for (let i = 0; i < numSegments; i++) {
      const segment = this.segmentStates[i];
      const wasStalled = this.prevSegmentStalled[i];
      const isStalled = segment.isStalled;

      // Spawn turbulence on stall transition or while stalled (rate-limited)
      if (isStalled) {
        const timeSinceLastSpawn = currentTime - this.lastSpawnTime[i];

        if (
          (!wasStalled || timeSinceLastSpawn >= TURBULENCE_SPAWN_INTERVAL) &&
          activeTurbulence < MAX_TURBULENCE_PARTICLES
        ) {
          this.spawnTurbulence(segment, wind);
          this.lastSpawnTime[i] = currentTime;
        }
      }

      this.prevSegmentStalled[i] = isStalled;
    }
  }

  /**
   * Spawn a turbulence particle downwind of a stalled segment.
   */
  private spawnTurbulence(segment: SailSegmentState, wind: Wind): void {
    if (!this.game) return;

    const windVel = wind.getBaseVelocityAtPoint(segment.position);
    if (windVel.magnitude < 0.01) return;

    // Spawn slightly downwind of the segment
    const spawnPos = segment.position.add(
      windVel.normalize().mul(TURBULENCE_SPAWN_OFFSET)
    );

    const particle = new TurbulenceParticle(spawnPos, windVel);
    this.game.addEntity(particle);
  }

  // WindModifier interface

  getWindModifierAABB(): AABB {
    const radius = this.sail.getWindInfluenceRadius();
    this.aabb.minX = this.centroid.x - radius;
    this.aabb.minY = this.centroid.y - radius;
    this.aabb.maxX = this.centroid.x + radius;
    this.aabb.maxY = this.centroid.y + radius;
    return this.aabb;
  }

  /**
   * O(1) wind contribution using pre-computed aggregate stats.
   * Uses zone-based directional effects:
   * - Leeward: accelerated flow parallel to surface
   * - Windward: decelerated/blocked flow
   * - Downwind: wake shadow zone (based on stall fraction)
   */
  getWindVelocityContribution(queryPoint: V2d): V2d {
    const influenceRadius = this.sail.getWindInfluenceRadius();

    // Quick check: is query point within overall influence radius?
    const toQuery = queryPoint.sub(this.centroid);
    const dist = toQuery.magnitude;

    if (dist < WIND_MIN_DISTANCE || dist > influenceRadius) {
      return V(0, 0);
    }

    // Classify query point relative to sail
    const toQueryDir = toQuery.mul(1 / dist);

    // Component perpendicular to sail (positive = leeward side)
    const normalComponent = toQueryDir.dot(this.averageNormal);

    // Component along wind direction (positive = downwind)
    const windComponent = toQueryDir.dot(this.windDirection);

    // Distance falloff (inverse linear)
    const distanceFalloff = 1 - dist / influenceRadius;

    // Lift-based strength (using aggregate values)
    const liftStrength =
      Math.abs(this.averageLiftCoefficient) * this.chordLength;

    // Use in-place math to avoid allocations
    let cx = 0;
    let cy = 0;

    if (normalComponent > 0.3) {
      // LEEWARD ZONE: Accelerated flow parallel to sail surface
      const acceleration =
        LEEWARD_ACCELERATION *
        liftStrength *
        normalComponent *
        distanceFalloff *
        this.windSpeed;

      // Flow accelerates in chord direction (toward trailing edge)
      cx += this.chordDirection.x * acceleration;
      cy += this.chordDirection.y * acceleration;
    } else if (normalComponent < -0.3) {
      // WINDWARD ZONE: Blocked/decelerated flow
      const blockage =
        WINDWARD_BLOCKAGE *
        liftStrength *
        Math.abs(normalComponent) *
        distanceFalloff *
        this.windSpeed;

      // Reduce wind velocity (negative contribution in wind direction)
      cx -= this.windDirection.x * blockage;
      cy -= this.windDirection.y * blockage;
    }

    // WAKE/SHADOW ZONE: Downwind of sail (scaled by stall fraction)
    if (windComponent > 0.5 && this.stallFraction > 0) {
      const wakeLength = this.chordLength * WAKE_LENGTH_FACTOR;
      const wakeDistance = dist * windComponent;

      if (wakeDistance < wakeLength) {
        const wakeFalloff = 1 - wakeDistance / wakeLength;
        const shadow =
          WAKE_SHADOW_FACTOR *
          this.stallFraction *
          wakeFalloff *
          this.windSpeed;

        // Reduce wind in the wake
        cx -= this.windDirection.x * shadow;
        cy -= this.windDirection.y * shadow;
      }
    }

    return V(cx, cy);
  }
}
