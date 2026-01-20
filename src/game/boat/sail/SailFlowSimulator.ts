import type { Body } from "../../../core/physics/body/Body";
import { clamp, degToRad } from "../../../core/util/MathUtil";
import { V, V2d } from "../../../core/Vector";
import {
  SEGMENT_INFLUENCE_RADIUS,
  TURBULENCE_DECAY,
  TURBULENCE_DETACH_THRESHOLD,
  TURBULENCE_STALL_INJECTION,
} from "../../world-data/wind/WindConstants";
import { createFlowState, FlowState } from "./FlowState";
import type { SailSegment } from "./SailSegment";

const STALL_ANGLE = degToRad(15);

/** Calculate camber from three points (prev, current, next). */
function calculateCamber(prev: V2d, current: V2d, next: V2d): number {
  const chord = next.sub(prev);
  const chordLength = chord.magnitude;
  if (chordLength < 0.001) return 0;

  const chordMidpoint = prev.add(chord.mul(0.5));
  const deviation = current.sub(chordMidpoint);

  const chordNormal = chord.normalize().rotate90cw();
  const camberDistance = deviation.dot(chordNormal);

  return camberDistance / chordLength;
}

/** Check if a sail is stalled at the given angle of attack. */
function isSailStalled(angleOfAttack: number): boolean {
  const alpha = Math.abs(angleOfAttack);
  const effectiveAlpha = alpha > Math.PI / 2 ? Math.PI - alpha : alpha;
  return effectiveAlpha > STALL_ANGLE;
}

/**
 * Simulates flow state propagation along a sail from luff to leech.
 * Models how stall and turbulence at the leading edge affect downstream segments.
 */
export class SailFlowSimulator {
  private segments: SailSegment[] = [];

  /**
   * Compute flow states for all segments.
   * @param bodies - Sail particle bodies
   * @param head - Head position (leading edge attachment)
   * @param clew - Clew position (trailing edge)
   * @param baseWind - Wind velocity at sail (before other sail contributions)
   * @param getUpwindContribution - Query function for upwind sail effects
   * @returns Array of segments with computed flow states
   */
  simulate(
    bodies: Body[],
    head: V2d,
    clew: V2d,
    baseWind: V2d,
    getUpwindContribution: (point: V2d) => V2d,
  ): SailSegment[] {
    // Update segment geometry from particle positions
    this.updateGeometry(bodies, head, clew);

    // Propagate flow from luff to leech
    let upstreamFlow = createFlowState();

    for (const segment of this.segments) {
      // Get apparent wind at this segment (base + upwind sail contributions)
      const contribution = getUpwindContribution(segment.position);
      const apparentWind = baseWind.add(contribution);

      // Compute flow state based on upstream + local geometry
      segment.flow = this.computeFlowState(segment, apparentWind, upstreamFlow);

      // Compute pressure field for this segment
      this.computePressure(segment);

      upstreamFlow = segment.flow;
    }

    return this.segments;
  }

  /**
   * Update segment geometry from particle positions.
   */
  private updateGeometry(bodies: Body[], head: V2d, clew: V2d): void {
    const numSegments = bodies.length - 1;

    // Resize segments array if needed
    while (this.segments.length < numSegments) {
      this.segments.push(this.createEmptySegment());
    }
    while (this.segments.length > numSegments) {
      this.segments.pop();
    }

    // Determine overall leeward direction from middle of sail
    const midIndex = Math.floor(bodies.length / 2);
    const midParticle = bodies[midIndex];
    const chordVec = clew.sub(head);
    const chordMidpoint = head.add(chordVec.mul(0.5));
    const billowDir = V(midParticle.position).sub(chordMidpoint);
    const chordNormal =
      chordVec.magnitude > 0.01 ? chordVec.normalize().rotate90cw() : V(0, 1);
    const leewardSign = billowDir.dot(chordNormal) > 0 ? 1 : -1;

    // Compute each segment's geometry
    for (let i = 0; i < numSegments; i++) {
      const segment = this.segments[i];

      const p0 = i === 0 ? head : V(bodies[i].position);
      const p1 = V(bodies[i + 1].position);
      const p2 = i + 2 < bodies.length ? V(bodies[i + 2].position) : clew;

      // Segment midpoint
      segment.position = p0.add(p1).mul(0.5);

      // Segment tangent and length
      const segmentVec = p1.sub(p0);
      segment.length = segmentVec.magnitude;
      segment.tangent =
        segment.length > 0.001 ? segmentVec.mul(1 / segment.length) : V(1, 0);

      // Normal pointing to leeward side
      const rawNormal = segment.tangent.rotate90cw();
      segment.normal = rawNormal.mul(leewardSign);

      // Local camber from 3-point geometry
      segment.camber = calculateCamber(p0, p1, p2);
    }
  }

  /**
   * Compute flow state for a segment based on apparent wind and upstream state.
   */
  private computeFlowState(
    segment: SailSegment,
    apparentWind: V2d,
    upstream: FlowState,
  ): FlowState {
    const speed = apparentWind.magnitude;
    const velocity = apparentWind.clone();

    if (speed < 0.01) {
      return createFlowState();
    }

    const flowDir = apparentWind.normalize();

    // Compute angle of attack
    const dotProduct = clamp(flowDir.dot(segment.tangent), -1, 1);
    const aoa = Math.acos(dotProduct);
    const wouldStall = isSailStalled(aoa);

    // Inherit turbulence from upstream (with decay)
    const inheritedTurbulence = upstream.turbulence * TURBULENCE_DECAY;

    // Determine attachment
    let attached: boolean;
    let turbulence: number;
    let stallDistance: number;

    if (
      upstream.attached &&
      !wouldStall &&
      inheritedTurbulence < TURBULENCE_DETACH_THRESHOLD
    ) {
      // Flow stays attached
      attached = true;
      turbulence = inheritedTurbulence;
      stallDistance = 0;
    } else {
      // Flow separated
      attached = false;
      turbulence = Math.min(
        1,
        inheritedTurbulence + (wouldStall ? TURBULENCE_STALL_INJECTION : 0.1),
      );
      stallDistance = upstream.stallDistance + segment.length;
    }

    // Pressure coefficient
    const pressure = attached
      ? -2 * Math.PI * Math.sin(aoa) // Attached: suction on leeward
      : -0.5; // Separated: reduced suction

    return {
      velocity,
      speed,
      attached,
      turbulence,
      pressure,
      stallDistance,
    };
  }

  /**
   * Compute windward and leeward pressure from flow state.
   */
  private computePressure(segment: SailSegment): void {
    const { flow, camber } = segment;

    if (!flow.attached) {
      segment.pressureWindward = 0.3;
      segment.pressureLeeward = -0.1;
      return;
    }

    if (flow.speed < 0.01) {
      segment.pressureWindward = 0;
      segment.pressureLeeward = 0;
      return;
    }

    const flowDir = flow.velocity.normalize();
    const dotProduct = clamp(flowDir.dot(segment.tangent), -1, 1);
    const aoa = Math.acos(dotProduct);
    const cl = 2 * Math.PI * Math.sin(aoa);

    segment.pressureWindward = 0.5 + 0.3 * Math.sin(aoa);
    segment.pressureLeeward = -0.5 * cl - camber * 2.0;
  }

  /**
   * Create an empty segment with default values.
   */
  private createEmptySegment(): SailSegment {
    return {
      position: V(0, 0),
      tangent: V(1, 0),
      normal: V(0, 1),
      length: 0,
      camber: 0,
      flow: createFlowState(),
      pressureWindward: 0,
      pressureLeeward: 0,
    };
  }

  /**
   * Get segment contribution to wind at a query point.
   * Used for sail-to-sail interaction.
   */
  getSegmentContribution(point: V2d, segment: SailSegment): V2d {
    const toPoint = point.sub(segment.position);
    const dist = toPoint.magnitude;

    if (dist < 1 || dist > SEGMENT_INFLUENCE_RADIUS) {
      return V(0, 0);
    }

    if (segment.flow.speed < 0.01) {
      return V(0, 0);
    }

    const toPointDir = toPoint.normalize();
    const normalComponent = toPointDir.dot(segment.normal);
    const falloff = 1 - dist / SEGMENT_INFLUENCE_RADIUS;

    // Leeward side: accelerate flow along tangent
    if (normalComponent > 0.2) {
      const accel =
        -segment.pressureLeeward * falloff * segment.flow.speed * 0.15;
      return segment.tangent.mul(accel);
    }
    // Windward side: block flow
    else if (normalComponent < -0.2) {
      const block =
        segment.pressureWindward * falloff * segment.flow.speed * 0.1;
      return segment.flow.velocity.normalize().mul(-block);
    }

    return V(0, 0);
  }
}
