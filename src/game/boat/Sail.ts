import BaseEntity from "../../core/entity/BaseEntity";
import type Body from "../../core/physics/body/Body";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { last, pairs, range } from "../../core/util/FunctionalUtils";
import { lerpV2d, stepToward } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces } from "../fluid-dynamics";
import type { Wind } from "../Wind";
import type { WindModifier } from "../WindModifier";
import {
  calculateCamber,
  DEFAULT_SAIL_CHORD,
  sailDrag,
  sailLift,
} from "./sail-helpers";
import { SailWindEffect } from "./SailWindEffect";
import { TellTail } from "./TellTail";

// Optional config with defaults
export interface SailConfig {
  nodeCount: number;
  nodeMass: number;
  slackFactor: number;
  liftScale: number;
  dragScale: number;
  sailShape: "boom" | "triangle";
  billowInner: number;
  billowOuter: number;
  windInfluenceRadius: number;
  hoistSpeed: number;
  color: number;
  getForceScale: (t: number) => number;
  attachTellTail: boolean;
}

// Required params (no defaults)
export interface SailParams {
  getHeadPosition: () => V2d; // Called each frame - head moves with boat
  headConstraint: { body: Body; localAnchor: V2d };
  // Optional with no default
  getClewPosition?: () => V2d; // Called each frame for constrained clews
  initialClewPosition?: V2d; // Only used once during construction
  clewConstraint?: { body: Body; localAnchor: V2d };
  extraPoints?: () => V2d[];
}

const DEFAULT_CONFIG: SailConfig = {
  nodeCount: 32,
  nodeMass: 0.04, // lbs per particle
  slackFactor: 1.01, // 1% slack in sail constraints
  liftScale: 2.0,
  dragScale: 2.0,
  sailShape: "boom",
  billowInner: 0.8, // Billow scale at boom
  billowOuter: 2.4, // Billow scale at leech
  windInfluenceRadius: 15, // ft - sail's wind shadow radius
  hoistSpeed: 0.4, // Full hoist/lower takes ~2.5 seconds
  color: 0xeeeeff,
  getForceScale: () => 1.0,
  attachTellTail: true,
};

export class Sail extends BaseEntity {
  layer = "sails" as const;
  bodies: DynamicBody[];
  constraints: NonNullable<BaseEntity["constraints"]>;

  // Hoist state (0 = fully lowered, 1 = fully hoisted)
  private hoistAmount: number = 0;
  private targetHoistAmount: number = 0;

  // Reference to our wind effect (for self-skip during wind queries)
  private windEffect: WindModifier | null = null;

  private config: SailParams & SailConfig;

  constructor(config: SailParams & Partial<SailConfig>) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    const {
      getHeadPosition,
      initialClewPosition,
      getClewPosition,
      headConstraint,
      clewConstraint,
      nodeCount,
      nodeMass,
      slackFactor,
      attachTellTail,
    } = this.config;

    const head = getHeadPosition();
    const initialClew = initialClewPosition ?? getClewPosition?.() ?? head;
    const totalLength = initialClew.distanceTo(head);
    const segmentLength = totalLength / (nodeCount - 1);

    // Create particle chain from head to clew
    this.bodies = range(nodeCount).map((i) =>
      new DynamicBody({
        mass: nodeMass,
        position: lerpV2d(head, initialClew, i / (nodeCount - 1)),
        collisionResponse: false,
        fixedRotation: true,
      }).addShape(new Particle()),
    );

    // Connect adjacent particles with distance constraints
    this.constraints = pairs(this.bodies).map(
      ([a, b]) =>
        new DistanceConstraint(a, b, {
          distance: segmentLength * slackFactor,
          collideConnected: false,
        }),
    );

    // Attach head (first particle) to specified body
    this.constraints.push(
      new DistanceConstraint(headConstraint.body, this.bodies[0], {
        distance: 0,
        collideConnected: false,
        localAnchorA: [
          headConstraint.localAnchor.x,
          headConstraint.localAnchor.y,
        ],
      }),
    );

    // Optionally attach clew (last particle) to specified body
    if (clewConstraint) {
      this.constraints.push(
        new DistanceConstraint(clewConstraint.body, last(this.bodies), {
          distance: 0,
          collideConnected: false,
          localAnchorA: [
            clewConstraint.localAnchor.x,
            clewConstraint.localAnchor.y,
          ],
        }),
      );
    }

    if (attachTellTail) {
      const attachmentBody = this.bodies[nodeCount - 1];
      this.addChild(
        new TellTail(
          () => attachmentBody.position,
          () => attachmentBody.velocity,
        ),
      );
    }

    this.windEffect = this.addChild(new SailWindEffect(this));
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
    return this.config.windInfluenceRadius;
  }

  /** Check if sail is hoisted (or hoisting) */
  isHoisted(): boolean {
    return this.targetHoistAmount > 0.5;
  }

  /** Get current hoist amount (0 = lowered, 1 = hoisted) */
  getHoistAmount(): number {
    return this.hoistAmount;
  }

  /** Set sail hoist state - will animate to target */
  setHoisted(hoisted: boolean): void {
    this.targetHoistAmount = hoisted ? 1 : 0;
  }

  onTick(dt: number) {
    const { hoistSpeed, getHeadPosition, getForceScale } = this.config;

    // Animate hoist amount toward target
    this.hoistAmount = stepToward(
      this.hoistAmount,
      this.targetHoistAmount,
      hoistSpeed * dt,
    );

    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind || this.hoistAmount <= 0) return;

    // Skip our own wind effect to prevent feedback loops
    const getFluidVelocity = (point: V2d): V2d =>
      wind.getVelocityAtPoint(point, this.windEffect ?? undefined);

    const head = getHeadPosition();
    const clew = this.getClewPosition();

    for (let i = 0; i < this.bodies.length; i++) {
      const t = i / (this.bodies.length - 1);
      const forceScale = getForceScale(t) * this.hoistAmount;

      const body = this.bodies[i];
      const bodyPos = V(body.position);
      const prevPos = i === 0 ? head : V(this.bodies[i - 1].position);
      const nextPos =
        i === this.bodies.length - 1 ? clew : V(this.bodies[i + 1].position);

      const camber = calculateCamber(prevPos, bodyPos, nextPos);
      // Use proper sail physics with real chord dimension
      // Scale effective chord by forceScale (position along sail and hoist amount)
      const effectiveChord = DEFAULT_SAIL_CHORD * forceScale;
      const lift = sailLift(effectiveChord, camber);
      const drag = sailDrag(effectiveChord);

      const v1Local = prevPos.sub(bodyPos);
      const v2Local = nextPos.sub(bodyPos);

      applyFluidForces(body, v1Local, v2Local, lift, drag, getFluidVelocity);
      applyFluidForces(body, v2Local, v1Local, lift, drag, getFluidVelocity);
    }
  }

  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    // Hide sail when fully lowered
    if (this.hoistAmount <= 0) {
      return;
    }

    const { billowOuter, billowInner, sailShape, color } = this.config;

    const head = this.config.getHeadPosition();
    const clew = this.getClewPosition();

    // Scale billow by hoist amount - sail flattens as it's lowered
    const scaledBillowOuter = billowOuter * this.hoistAmount;
    const scaledBillowInner = billowInner * this.hoistAmount;

    // Fade alpha near the end of lowering (stays opaque until ~40% lowered)
    const fadeStart = 0.4;
    const alpha =
      this.hoistAmount >= fadeStart ? 1 : (this.hoistAmount / fadeStart) ** 0.5; // sqrt easing for smooth fade

    const path = draw.path();

    if (sailShape === "triangle") {
      // Triangle rendering: single polygon with billow on one edge
      // head → particles with billow → clew → extraPoints → back to head
      path.moveTo(head.x, head.y);

      // Billowed edge (foot for jib)
      for (let i = 1; i < this.bodies.length - 1; i++) {
        const body = this.bodies[i];
        const t = i / (this.bodies.length - 1);
        const baseline = lerpV2d(head, clew, t);
        const [x, y] = lerpV2d(baseline, body.position, scaledBillowOuter);
        path.lineTo(x, y);
      }
      path.lineTo(clew.x, clew.y);

      // Extra points (e.g., masthead for jib - forms the leech)
      // Scale extra points toward clew as sail is lowered
      const extraPoints = this.config.extraPoints?.() ?? [];
      for (const point of extraPoints) {
        const scaledPoint = lerpV2d(clew, point, this.hoistAmount);
        path.lineTo(scaledPoint.x, scaledPoint.y);
      }

      const scaledHead = lerpV2d(clew, head, this.hoistAmount);
      path.lineTo(scaledHead.x, scaledHead.y);

      path.close();
      path.fill(color, alpha);
      draw.screenLine(head.x, head.y, clew.x, clew.y, {
        color,
        alpha,
        width: 1,
      });
    } else {
      // Boom rendering: double-pass with inner and outer billow
      path.moveTo(head.x, head.y);

      // Outer edge: head → particles (with billowOuter) → clew
      for (let i = 1; i < this.bodies.length - 1; i++) {
        const body = this.bodies[i];
        const t = i / (this.bodies.length - 1);
        const baseline = lerpV2d(head, clew, t);
        const [x, y] = lerpV2d(baseline, body.position, scaledBillowOuter);
        path.lineTo(x, y);
      }
      path.lineTo(clew.x, clew.y);

      // Inner edge: back to head (with billowInner)
      const reversedBodies = this.bodies.toReversed();
      for (let i = 1; i < reversedBodies.length - 1; i++) {
        const body = reversedBodies[i];
        const t = i / (this.bodies.length - 1);
        const baseline = lerpV2d(clew, head, t);
        const [x, y] = lerpV2d(baseline, body.position, scaledBillowInner);
        path.lineTo(x, y);
      }

      path.close();
      path.fill(color, alpha);
      draw.screenLine(head.x, head.y, clew.x, clew.y, {
        color,
        alpha,
        width: 1,
      });
    }
  }
}
