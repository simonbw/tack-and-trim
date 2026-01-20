import BaseEntity from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type Body from "../../../core/physics/body/Body";
import DynamicBody from "../../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../../core/physics/constraints/DistanceConstraint";
import Particle from "../../../core/physics/shapes/Particle";
import { AABB } from "../../../core/util/SparseSpatialHash";
import { last, pairs, range } from "../../../core/util/FunctionalUtils";
import { lerpV2d, stepToward } from "../../../core/util/MathUtil";
import { V, V2d } from "../../../core/Vector";
import type { QueryForecast } from "../../world-data/datatiles/DataTileTypes";
import type { WindQuerier } from "../../world-data/wind/WindQuerier";
import { WindInfo } from "../../world-data/wind/WindInfo";
import { SEGMENT_INFLUENCE_RADIUS } from "../../world-data/wind/WindConstants";
import { WindModifier } from "../../WindModifier";
import { applySailForces } from "./sail-aerodynamics";
import { SailFlowSimulator } from "./SailFlowSimulator";
import type { SailSegment } from "./SailSegment";
import { TellTail } from "./TellTail";

// Default sail chord (depth from luff to leech) in feet
const DEFAULT_SAIL_CHORD = 5.0;

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

export class Sail extends BaseEntity implements WindModifier, WindQuerier {
  layer = "sails" as const;
  tags = ["windQuerier", "sail", "windModifier"];
  bodies: DynamicBody[];
  constraints: NonNullable<BaseEntity["constraints"]>;

  // Hoist state (0 = fully lowered, 1 = fully hoisted)
  hoistAmount: number = 0;
  targetHoistAmount: number = 0;

  // Flow simulation
  private flowSimulator = new SailFlowSimulator();
  private cachedSegments: SailSegment[] = [];
  private flowComputedFrame: number = -1;
  private inFlowComputation: boolean = false;

  // Reusable AABB for WindModifier
  private readonly aabb: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

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
          () => this.hoistAmount,
        ),
      );
    }
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

  @on("tick")
  onTick(dt: number) {
    const { hoistSpeed, getForceScale } = this.config;

    // Animate hoist amount toward target
    this.hoistAmount = stepToward(
      this.hoistAmount,
      this.targetHoistAmount,
      hoistSpeed * dt,
    );

    if (!this.isHoisted() || this.hoistAmount <= 0) return;

    // Get flow states (triggers upwind sail computation if needed)
    const segments = this.getFlowStates();
    if (segments.length === 0) return;

    // Apply forces based on flow states
    for (let i = 0; i < this.bodies.length; i++) {
      const t = i / (this.bodies.length - 1);
      const forceScale = getForceScale(t) * this.hoistAmount;

      // Find corresponding segment (bodies.length = segments.length + 1)
      const segmentIndex = Math.min(i, segments.length - 1);
      const segment = segments[segmentIndex];

      applySailForces(this.bodies[i], segment, DEFAULT_SAIL_CHORD, forceScale);
    }
  }

  /**
   * Get flow states for all segments. Lazy computation with per-frame caching.
   * Automatically triggers computation of upwind sails first.
   */
  getFlowStates(): SailSegment[] {
    const currentFrame = this.game?.ticknumber ?? 0;

    if (this.flowComputedFrame === currentFrame) {
      return this.cachedSegments;
    }

    // Guard against infinite recursion from mutual upwind sail references
    if (this.inFlowComputation) {
      throw new Error(
        "Recursive getFlowStates() call detected on same sail - this would cause an infinite loop",
      );
    }

    if (!this.game) {
      return [];
    }
    const wind = WindInfo.fromGame(this.game);

    try {
      this.inFlowComputation = true;

      // Get upwind sails and trigger their flow computation first
      const upwindSails = this.getUpwindSails();

      // Build contribution function from upwind sails
      const getUpwindContribution = (point: V2d): V2d => {
        let contribution = V(0, 0);
        for (const sail of upwindSails) {
          contribution.iadd(sail.getWindContributionAt(point));
        }
        return contribution;
      };

      // Get base wind at sail centroid
      const baseWind = wind.getBaseVelocityAtPoint(this.getCentroid());

      // Run flow simulation
      this.cachedSegments = this.flowSimulator.simulate(
        this.bodies,
        this.getHeadPosition(),
        this.getClewPosition(),
        baseWind,
        getUpwindContribution,
      );
      this.flowComputedFrame = currentFrame;
    } finally {
      this.inFlowComputation = false;
    }

    return this.cachedSegments;
  }

  /**
   * Get sails that are upwind of this sail and might affect it.
   * Uses midpoint wind direction to guarantee asymmetry: if A sees B as upwind,
   * B cannot see A as upwind, preventing infinite recursion.
   */
  private getUpwindSails(): Sail[] {
    if (!this.game) return [];
    const wind = WindInfo.fromGame(this.game);

    const myPos = this.getCentroid();

    const allSails = [
      ...(this.game?.entities.getTagged("sail") ?? []),
    ] as Sail[];
    return allSails.filter((sail) => {
      if (sail === this) return false;
      const otherPos = sail.getCentroid();
      // Use wind at midpoint to ensure both sails agree on direction
      const midpoint = myPos.add(otherPos).mul(0.5);
      const windDir = wind.getBaseVelocityAtPoint(midpoint).normalize();
      const toOther = otherPos.sub(myPos);
      return toOther.dot(windDir) < 0; // Other sail is upwind
    });
  }

  /**
   * Get wind velocity contribution at a point from this sail's pressure field.
   * Used by downwind sails querying this sail's effect.
   */
  getWindContributionAt(point: V2d): V2d {
    const segments = this.getFlowStates();
    let contribution = V(0, 0);

    for (const segment of segments) {
      contribution.iadd(
        this.flowSimulator.getSegmentContribution(point, segment),
      );
    }

    return contribution;
  }

  /**
   * Get the sail centroid (approximately 1/3 along chord from head).
   */
  private getCentroid(): V2d {
    const head = this.getHeadPosition();
    const clew = this.getClewPosition();
    return head.add(clew.sub(head).mul(0.33));
  }

  // WindModifier interface

  getWindModifierAABB(): AABB {
    const centroid = this.getCentroid();
    const radius = this.config.windInfluenceRadius + SEGMENT_INFLUENCE_RADIUS;
    this.aabb.minX = centroid.x - radius;
    this.aabb.minY = centroid.y - radius;
    this.aabb.maxX = centroid.x + radius;
    this.aabb.maxY = centroid.y + radius;
    return this.aabb;
  }

  getWindVelocityContribution(queryPoint: V2d): V2d {
    if (!this.isHoisted()) {
      return V(0, 0);
    }
    return this.getWindContributionAt(queryPoint);
  }

  @on("render")
  onRender({ draw }: { draw: import("../../../core/graphics/Draw").Draw }) {
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

  getWindQueryForecast(): QueryForecast | null {
    // Don't forecast if sail is lowered
    if (this.hoistAmount <= 0) return null;

    // Compute AABB around all sail bodies
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const body of this.bodies) {
      const [x, y] = body.position;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    // Add a margin for edge queries
    const margin = 2;
    return {
      aabb: {
        minX: minX - margin,
        minY: minY - margin,
        maxX: maxX + margin,
        maxY: maxY + margin,
      },
      // ~2 queries per body (prev/next edges)
      queryCount: this.bodies.length * 2,
    };
  }
}
