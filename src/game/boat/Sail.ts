import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import Body from "../../core/physics/body/Body";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { last, pairs, range } from "../../core/util/FunctionalUtils";
import { lerpV2d } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces } from "../fluid-dynamics";
import type { Wind } from "../Wind";
import { WindModifier } from "../WindModifier";
import {
  calculateCamber,
  getSailLiftCoefficient,
  isSailStalled,
  sailDrag,
  sailLift,
} from "./sail-helpers";
import { TellTail } from "./TellTail";

// Default values
const DEFAULT_NODE_COUNT = 32;
const DEFAULT_NODE_MASS = 0.04;
const DEFAULT_SLACK_FACTOR = 1.01;
const DEFAULT_LIFT_SCALE = 2.0;
const DEFAULT_DRAG_SCALE = 2.0;
const DEFAULT_BILLOW_INNER = 0.8;
const DEFAULT_BILLOW_OUTER = 2.4;
const DEFAULT_WIND_INFLUENCE_RADIUS = 50;
const WIND_INFLUENCE_SCALE = 0.15;
const WIND_MIN_DISTANCE = 5;
const STALL_TURBULENCE_SCALE = 15;

export interface SailConfig {
  // Particle configuration
  nodeCount?: number;
  nodeMass?: number;
  slackFactor?: number;
  liftScale?: number;
  dragScale?: number;

  // Position providers
  getHeadPosition: () => V2d;
  getClewPosition?: () => V2d; // Optional - defaults to reading from clew particle if no clewConstraint
  getInitialClewPosition?: () => V2d; // Required if getClewPosition not provided

  // Constraints
  headConstraint: { body: Body; localAnchor: V2d };
  clewConstraint?: { body: Body; localAnchor: V2d };

  // Force distribution (t: 0=head, 1=clew)
  getForceScale?: (t: number) => number;

  // Rendering
  sailShape?: "boom" | "triangle"; // 'boom' = double-pass (mainsail), 'triangle' = single polygon (jib)
  billowInner?: number;
  billowOuter?: number;
  extraPoints?: () => V2d[]; // Additional vertices after clew (e.g., masthead for triangle jib)

  // Extras
  attachTellTail?: boolean;
  windInfluenceRadius?: number;
}

export class Sail extends BaseEntity implements WindModifier {
  sprite: GameSprite & Graphics;
  bodies: NonNullable<BaseEntity["bodies"]>;
  constraints: NonNullable<BaseEntity["constraints"]>;

  // Resolved config values
  private readonly nodeCount: number;
  private readonly nodeMass: number;
  private readonly slackFactor: number;
  private readonly liftScale: number;
  private readonly dragScale: number;
  private readonly sailShape: "boom" | "triangle";
  private readonly billowInner: number;
  private readonly billowOuter: number;
  private readonly windInfluenceRadius: number;
  private readonly getForceScale: (t: number) => number;

  // Wind modifier state
  private windModifierPosition: V2d = V(0, 0);
  private windModifierNormal: V2d = V(0, 1);
  private currentLiftCoefficient: number = 0;
  private currentChordLength: number = 0;
  private currentWindSpeed: number = 0;
  private isStalled: boolean = false;

  constructor(private config: SailConfig) {
    super();

    this.sprite = createGraphics("sails");
    this.bodies = [];
    this.constraints = [];

    // Resolve config with defaults
    this.nodeCount = config.nodeCount ?? DEFAULT_NODE_COUNT;
    this.nodeMass = config.nodeMass ?? DEFAULT_NODE_MASS;
    this.slackFactor = config.slackFactor ?? DEFAULT_SLACK_FACTOR;
    this.liftScale = config.liftScale ?? DEFAULT_LIFT_SCALE;
    this.dragScale = config.dragScale ?? DEFAULT_DRAG_SCALE;
    this.sailShape = config.sailShape ?? "boom";
    this.billowInner = config.billowInner ?? DEFAULT_BILLOW_INNER;
    this.billowOuter = config.billowOuter ?? DEFAULT_BILLOW_OUTER;
    this.windInfluenceRadius =
      config.windInfluenceRadius ?? DEFAULT_WIND_INFLUENCE_RADIUS;
    this.getForceScale = config.getForceScale ?? (() => 1.0);
  }

  /** Get head body (first particle) */
  getHead(): Body {
    return this.bodies[0];
  }

  /** Get clew body (last particle) */
  getClew(): Body {
    return last(this.bodies);
  }

  /** Get current clew position - from config or from particle */
  private getClewPosition(): V2d {
    if (this.config.getClewPosition) {
      return this.config.getClewPosition();
    }
    // Default: read from last particle (for free-clew sails)
    return V(last(this.bodies).position);
  }

  onAdd() {
    const head = this.config.getHeadPosition();
    const initialClew =
      this.config.getInitialClewPosition?.() ??
      this.config.getClewPosition?.() ??
      head; // Fallback, will be overwritten
    const totalLength = initialClew.distanceTo(head);
    const segmentLength = totalLength / (this.nodeCount - 1);

    // Create particle chain from head to clew
    this.bodies = range(this.nodeCount).map((i) => {
      const t = i / (this.nodeCount - 1);
      const body = new DynamicBody({
        mass: this.nodeMass,
        position: lerpV2d(head, initialClew, t),
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

    // Attach head (first particle) to specified body
    const { body: headBody, localAnchor: headAnchor } =
      this.config.headConstraint;
    this.constraints.push(
      new DistanceConstraint(headBody, this.bodies[0], {
        distance: 0,
        collideConnected: false,
        localAnchorA: [headAnchor.x, headAnchor.y],
      })
    );

    // Optionally attach clew (last particle) to specified body
    if (this.config.clewConstraint) {
      const { body: clewBody, localAnchor: clewAnchor } =
        this.config.clewConstraint;
      this.constraints.push(
        new DistanceConstraint(clewBody, last(this.bodies), {
          distance: 0,
          collideConnected: false,
          localAnchorA: [clewAnchor.x, clewAnchor.y],
        })
      );
    }

    // Add slack to allow billowing
    for (const constraint of this.constraints) {
      if (constraint instanceof DistanceConstraint) {
        constraint.distance = constraint.distance * this.slackFactor;
      }
    }

    // Optionally add telltail
    if (this.config.attachTellTail !== false) {
      this.addChild(new TellTail(this.bodies[this.nodeCount - 1]));
    }

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

    const getFluidVelocity = (point: V2d): V2d =>
      wind.getVelocityAtPoint(point);

    const head = this.config.getHeadPosition();
    const clew = this.getClewPosition();

    for (let i = 0; i < this.bodies.length; i++) {
      const t = i / (this.bodies.length - 1);
      const forceScale = this.getForceScale(t);

      const body = this.bodies[i];
      const bodyPos = V(body.position);

      // Get previous and next positions for edge calculation
      const prevPos = i === 0 ? head : V(this.bodies[i - 1].position);
      const nextPos =
        i === this.bodies.length - 1 ? clew : V(this.bodies[i + 1].position);

      // Calculate local camber
      const camber = calculateCamber(prevPos, bodyPos, nextPos);

      // Create force magnitude functions
      const lift = sailLift(this.liftScale * forceScale, camber);
      const drag = sailDrag(this.dragScale * forceScale);

      // Virtual edge from prev to next
      const v1Local = prevPos.sub(bodyPos);
      const v2Local = nextPos.sub(bodyPos);

      applyFluidForces(body, v1Local, v2Local, lift, drag, getFluidVelocity);
      applyFluidForces(body, v2Local, v1Local, lift, drag, getFluidVelocity);
    }

    this.updateWindModifierState(wind);
  }

  private updateWindModifierState(wind: Wind) {
    const head = this.config.getHeadPosition();
    const clew = this.getClewPosition();

    // Chord from head to clew
    const chord = clew.sub(head);
    this.currentChordLength = chord.magnitude;

    // Normal perpendicular to chord
    const midParticle = this.bodies[Math.floor(this.bodies.length / 2)];
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

      const prevPos = V(
        this.bodies[Math.floor(this.bodies.length / 2) - 1].position
      );
      const nextPos = V(
        this.bodies[Math.floor(this.bodies.length / 2) + 1].position
      );
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

  // WindModifier interface

  getWindModifierPosition(): V2d {
    return this.windModifierPosition;
  }

  getWindModifierInfluenceRadius(): number {
    return this.windInfluenceRadius;
  }

  getWindVelocityContribution(queryPoint: V2d): V2d {
    const toQuery = queryPoint.sub(this.windModifierPosition);
    const r = toQuery.magnitude;

    if (r < WIND_MIN_DISTANCE || r > this.windInfluenceRadius) {
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

  onRender() {
    const head = this.config.getHeadPosition();
    const clew = this.getClewPosition();

    this.sprite.clear();

    if (this.sailShape === "triangle") {
      // Triangle rendering: single polygon with billow on one edge
      // head → particles with billow → clew → extraPoints → back to head
      this.sprite.moveTo(head.x, head.y);

      // Billowed edge (foot for jib)
      for (let i = 1; i < this.bodies.length - 1; i++) {
        const body = this.bodies[i];
        const t = i / (this.bodies.length - 1);
        const baseline = lerpV2d(head, clew, t);
        const [x, y] = lerpV2d(baseline, body.position, this.billowOuter);
        this.sprite.lineTo(x, y);
      }
      this.sprite.lineTo(clew.x, clew.y);

      // Extra points (e.g., masthead for jib - forms the leech)
      const extraPoints = this.config.extraPoints?.() ?? [];
      for (const point of extraPoints) {
        this.sprite.lineTo(point.x, point.y);
      }

      // Close path back to head (forms the luff)
      this.sprite
        .closePath()
        .fill({ color: 0xeeeeff })
        .stroke({ color: 0xeeeeff, join: "round", width: 1 });
    } else {
      // Boom rendering: double-pass with inner and outer billow
      this.sprite.moveTo(head.x, head.y);

      // Outer edge: head → particles (with billowOuter) → clew
      for (let i = 1; i < this.bodies.length - 1; i++) {
        const body = this.bodies[i];
        const t = i / (this.bodies.length - 1);
        const baseline = lerpV2d(head, clew, t);
        const [x, y] = lerpV2d(baseline, body.position, this.billowOuter);
        this.sprite.lineTo(x, y);
      }
      this.sprite.lineTo(clew.x, clew.y);

      // Inner edge: back to head (with billowInner)
      const reversedBodies = this.bodies.toReversed();
      for (let i = 1; i < reversedBodies.length - 1; i++) {
        const body = reversedBodies[i];
        const t = i / (this.bodies.length - 1);
        const baseline = lerpV2d(clew, head, t);
        const [x, y] = lerpV2d(baseline, body.position, this.billowInner);
        this.sprite.lineTo(x, y);
      }

      this.sprite
        .closePath()
        .fill({ color: 0xeeeeff })
        .stroke({ color: 0xeeeeff, join: "round", width: 1 });
    }
  }
}
