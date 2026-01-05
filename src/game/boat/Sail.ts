import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import type Body from "../../core/physics/body/Body";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { last, pairs, range } from "../../core/util/FunctionalUtils";
import { lerpV2d } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces } from "../fluid-dynamics";
import type { Wind } from "../Wind";
import { calculateCamber, sailDrag, sailLift } from "./sail-helpers";
import { SailWindEffect } from "./SailWindEffect";
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

export class Sail extends BaseEntity {
  sprite: GameSprite & Graphics;
  bodies: DynamicBody[];
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

  // Hoist state
  private hoisted: boolean = true;

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

  /** Get current head position */
  getHeadPosition(): V2d {
    return this.config.getHeadPosition();
  }

  /** Get current clew position - from config or from particle */
  getClewPosition(): V2d {
    if (this.config.getClewPosition) {
      return this.config.getClewPosition();
    }
    // Default: read from last particle (for free-clew sails)
    return V(last(this.bodies).position);
  }

  /** Get all particle bodies */
  getBodies(): Body[] {
    return this.bodies;
  }

  /** Get wind influence radius */
  getWindInfluenceRadius(): number {
    return this.windInfluenceRadius;
  }

  /** Check if sail is hoisted */
  isHoisted(): boolean {
    return this.hoisted;
  }

  /** Set sail hoist state */
  setHoisted(hoisted: boolean): void {
    this.hoisted = hoisted;
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

    // Add wind effect child
    this.addChild(new SailWindEffect(this));
  }

  onTick() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    // When sail is lowered, skip all forces
    if (!this.hoisted) {
      return;
    }

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
  }

  onRender() {
    this.sprite.clear();

    // Hide sail when lowered
    if (!this.hoisted) {
      return;
    }

    const head = this.config.getHeadPosition();
    const clew = this.getClewPosition();

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
