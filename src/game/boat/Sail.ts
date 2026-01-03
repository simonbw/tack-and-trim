import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { last, pairs, range } from "../../core/util/FunctionalUtils";
import { lerpV2d } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces } from "../fluid-dynamics";
import type { Wind } from "../Wind";
import { WindModifier } from "../WindModifier";
import { Rig } from "./Rig";
import {
  calculateCamber,
  getSailLiftCoefficient,
  isSailStalled,
  sailDrag,
  sailLift,
} from "./sail-helpers";
import { TellTail } from "./TellTail";

const SAIL_NODES = 32;
const SAIL_NODE_MASS = 0.04;
const LIFT_SCALE = 2.0;
const DRAG_SCALE = 2.0;
const SLACK_FACTOR = 1.01; // extra distance allowed between sail nodes
const BILLOW_INNER = 0.8; // how much the inner edge of the sail billows for rendering
const BILLOW_OUTER = 2.4; // how much the outer edge of the sail billows for rendering

// Wind modifier configuration
const WIND_INFLUENCE_RADIUS = 500; // How far sail affects wind
const WIND_INFLUENCE_SCALE = 0.15; // Strength of circulation effect
const WIND_MIN_DISTANCE = 5; // Minimum distance to avoid singularity
const STALL_TURBULENCE_SCALE = 15; // Random perturbation when stalled

export class Sail extends BaseEntity implements WindModifier {
  sprite: GameSprite & Graphics;
  bodies: NonNullable<BaseEntity["bodies"]>;
  constraints: NonNullable<BaseEntity["constraints"]>;

  // Wind modifier state (updated each tick)
  private windModifierPosition: V2d = V(0, 0);
  private windModifierNormal: V2d = V(0, 1); // Perpendicular to sail chord
  private currentLiftCoefficient: number = 0;
  private currentChordLength: number = 0;
  private currentWindSpeed: number = 0;
  private isStalled: boolean = false;

  constructor(private rig: Rig) {
    super();

    this.sprite = createGraphics("sails");

    this.bodies = [];
    this.constraints = [];
  }

  onAdd() {
    const start = this.rig.getMastWorldPosition();
    const end = this.rig.getBoomEndWorldPosition();
    const totalLength = end.sub(start).magnitude;
    const segmentLength = totalLength / (SAIL_NODES - 1);

    this.bodies = range(SAIL_NODES).map((i) => {
      const t = i / (SAIL_NODES - 1);
      const body = new DynamicBody({
        mass: SAIL_NODE_MASS,
        position: lerpV2d(start, end, t),
        collisionResponse: false,
        fixedRotation: true,
      });
      body.addShape(new Particle());
      return body;
    });

    // Connect adjacent particles with distance constraints
    for (const [a, b] of pairs(this.bodies)) {
      this.constraints.push(
        new DistanceConstraint(a, b, {
          distance: segmentLength,
          collideConnected: false,
        })
      );
    }

    // Attach first particle to boom at mast (pivot point)
    this.constraints.push(
      new DistanceConstraint(this.rig.body, this.bodies[0], {
        // distance: 0,
        collideConnected: false,
        localAnchorA: [0, 0],
      })
    );

    // Attach last particle to boom end
    this.constraints.push(
      new DistanceConstraint(this.rig.body, last(this.bodies), {
        // distance: 0,
        collideConnected: false,
        localAnchorA: [-this.rig.getBoomLength(), 0],
      })
    );

    // Add slack to allow billowing
    for (const constraint of this.constraints) {
      if (constraint instanceof DistanceConstraint) {
        constraint.distance = constraint.distance * SLACK_FACTOR;
      }
    }

    // Add telltail attached to a sail particle
    this.addChild(new TellTail(this.bodies[SAIL_NODES - 1]));

    // Register as wind modifier
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    wind?.registerModifier(this);
  }

  onDestroy() {
    // Unregister from wind modifier system
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    wind?.unregisterModifier(this);
  }

  onTick() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    const getFluidVelocity = (point: V2d): V2d =>
      wind.getVelocityAtPoint([point.x, point.y]);

    for (let i = 0; i < this.bodies.length; i++) {
      const t = i / (this.bodies.length - 1);

      const body = this.bodies[i];
      const bodyPos = V(body.position);

      // Get previous and next connection points in world space
      const prevPos =
        i === 0
          ? this.rig.getMastWorldPosition()
          : V(this.bodies[i - 1].position);
      const nextPos =
        i === this.bodies.length - 1
          ? this.rig.getBoomEndWorldPosition()
          : V(this.bodies[i + 1].position);

      // Calculate local camber (how curved the sail is at this point)
      const camber = calculateCamber(prevPos, bodyPos, nextPos);

      // Force decreases toward boom end because it's a triangular sail
      const triangleCompensation = 1.0 - t;

      // Create force magnitude functions for this segment
      const lift = sailLift(LIFT_SCALE * triangleCompensation, camber);
      const drag = sailDrag(DRAG_SCALE * triangleCompensation);

      // Virtual edge from prev to next, expressed in body-local coordinates
      const v1Local = prevPos.sub(bodyPos);
      const v2Local = nextPos.sub(bodyPos);

      applyFluidForces(body, v1Local, v2Local, lift, drag, getFluidVelocity);
      applyFluidForces(body, v2Local, v1Local, lift, drag, getFluidVelocity);
    }

    // Update wind modifier state for circulation calculation
    this.updateWindModifierState(wind);
  }

  /**
   * Compute aggregate sail state for wind modification.
   * Uses sail geometry and wind to determine circulation strength.
   */
  private updateWindModifierState(wind: Wind) {
    const mastPos = this.rig.getMastWorldPosition();
    const boomEndPos = this.rig.getBoomEndWorldPosition();

    // Chord is from mast to boom end
    const chord = boomEndPos.sub(mastPos);
    this.currentChordLength = chord.magnitude;

    // Normal perpendicular to chord (leeward direction depends on sail shape)
    // Use sail billowing to determine which side is leeward
    const midParticle = this.bodies[Math.floor(this.bodies.length / 2)];
    const chordMidpoint = mastPos.add(chord.mul(0.5));
    const billowDir = V(midParticle.position).sub(chordMidpoint);
    const chordNormal = chord.normalize().rotate90cw();
    // Normal points toward the billowed side (leeward)
    this.windModifierNormal =
      billowDir.dot(chordNormal) > 0 ? chordNormal : chordNormal.mul(-1);

    // Position at sail centroid (weighted toward mast for triangular sail)
    this.windModifierPosition = mastPos.add(chord.mul(0.33));

    // Get base wind at sail position (use base to avoid feedback loop)
    const baseWind = wind.getBaseVelocityAtPoint([
      this.windModifierPosition.x,
      this.windModifierPosition.y,
    ]);
    this.currentWindSpeed = baseWind.magnitude;

    // Calculate angle of attack from wind and sail orientation
    if (this.currentWindSpeed > 0.01 && this.currentChordLength > 0.01) {
      const windDir = baseWind.normalize();
      const chordDir = chord.normalize();
      const angleOfAttack = Math.acos(
        Math.max(-1, Math.min(1, windDir.dot(chordDir)))
      );

      // Average camber from middle of sail
      const prevPos = V(this.bodies[Math.floor(this.bodies.length / 2) - 1].position);
      const nextPos = V(this.bodies[Math.floor(this.bodies.length / 2) + 1].position);
      const camber = calculateCamber(prevPos, V(midParticle.position), nextPos);

      this.currentLiftCoefficient = getSailLiftCoefficient(angleOfAttack, camber);
      this.isStalled = isSailStalled(angleOfAttack);
    } else {
      this.currentLiftCoefficient = 0;
      this.isStalled = false;
    }
  }

  // WindModifier interface implementation

  getWindModifierPosition(): V2d {
    return this.windModifierPosition;
  }

  getWindModifierInfluenceRadius(): number {
    return WIND_INFLUENCE_RADIUS;
  }

  /**
   * Calculate velocity contribution at a query point using circulation model.
   * A lifting sail acts like a bound vortex, inducing tangential velocity.
   */
  getWindVelocityContribution(queryPoint: V2d): V2d {
    const toQuery = queryPoint.sub(this.windModifierPosition);
    const r = toQuery.magnitude;

    if (r < WIND_MIN_DISTANCE || r > WIND_INFLUENCE_RADIUS) {
      return V(0, 0);
    }

    // Circulation strength: Γ = Cl × chord × windSpeed
    const gamma =
      this.currentLiftCoefficient *
      this.currentChordLength *
      this.currentWindSpeed;

    // Induced velocity magnitude decays with distance (1/r)
    const magnitude =
      (Math.abs(gamma) * WIND_INFLUENCE_SCALE) /
      Math.max(r, WIND_MIN_DISTANCE);

    // Direction: tangent to circles around sail (creates rotation)
    // Sign of gamma determines rotation direction
    const tangent = toQuery.normalize().rotate90ccw();
    let contribution = tangent.mul(magnitude * Math.sign(gamma));

    // Add turbulence when stalled
    if (this.isStalled) {
      const turbulence = V(
        (Math.random() - 0.5) * STALL_TURBULENCE_SCALE,
        (Math.random() - 0.5) * STALL_TURBULENCE_SCALE
      );
      contribution = contribution.add(turbulence);
    }

    return contribution;
  }

  onRender() {
    this.sprite.clear();
    const start = this.rig.getMastWorldPosition();
    const end = this.rig.getBoomEndWorldPosition();

    // Outside of sail - skip first and last bodies since they're constrained
    // to start/end positions, which avoids degenerate line segments
    this.sprite.moveTo(start.x, start.y);
    for (let i = 1; i < this.bodies.length - 1; i++) {
      const body = this.bodies[i];
      const t = i / (this.bodies.length - 1);
      const boomPosition = lerpV2d(start, end, t);
      const [x, y] = lerpV2d(boomPosition, body.position, BILLOW_INNER);
      this.sprite.lineTo(x, y);
    }
    this.sprite.lineTo(end.x, end.y);

    // Inside - trace back along the boom with slight offset toward sail
    // Skip first and last to avoid near-zero segments at endpoints
    const reversedBodies = this.bodies.toReversed();
    for (let i = 1; i < reversedBodies.length - 1; i++) {
      const body = reversedBodies[i];
      const t = i / (this.bodies.length - 1);
      const boomPosition = lerpV2d(end, start, t);
      const [x, y] = lerpV2d(boomPosition, body.position, BILLOW_OUTER);
      this.sprite.lineTo(x, y);
    }

    this.sprite
      .closePath()
      .fill({ color: 0xeeeeff })
      .stroke({ color: 0xeeeeff, join: "round", width: 1 });
  }
}
