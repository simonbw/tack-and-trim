import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { DynamicBody } from "../../../core/physics/body/DynamicBody";
import { DistanceConstraint } from "../../../core/physics/constraints/DistanceConstraint";
import { Particle } from "../../../core/physics/shapes/Particle";
import { pairs, range } from "../../../core/util/FunctionalUtils";
import { ReadonlyV2d, V, V2d } from "../../../core/Vector";
import {
  applyFluidForces,
  flatPlateDrag,
  ForceMagnitudeFn,
} from "../../fluid-dynamics";
import { WindQuery } from "../../world/wind/WindQuery";

// Units: feet (ft), lbs
// TellTail dimensions
const TELLTAIL_NODES = 6;
const TELLTAIL_NODE_MASS = 0.01; // lbs per particle (tuned for physics)
const TELLTAIL_LENGTH = 2; // ft - total streamer length
const SLACK_FACTOR = 1.02; // Dimensionless constraint slack

// Drag parameters
const DRAG_SCALE = 0.5; // Dimensionless drag coefficient

// Rendering
const TELLTAIL_WIDTH = 0.3; // ft - visual ribbon width
const TELLTAIL_COLOR = 0xff6600;

/** No lift for a thin streamer - it just gets pushed by the wind. */
const noLift: ForceMagnitudeFn = () => 0;

export class TellTail extends BaseEntity {
  layer = "telltails" as const;
  bodies: DynamicBody[];
  constraints: NonNullable<BaseEntity["constraints"]>;
  getAttachmentPoint: () => ReadonlyV2d;
  getAttachmentVelocity: () => ReadonlyV2d;
  getHoistAmount: () => number;

  // Wind query for each body (except first which is attached to sail)
  private windQuery: WindQuery;

  constructor(
    getAttachmentPoint: () => ReadonlyV2d,
    getAttachmentVelocity: () => ReadonlyV2d,
    getHoistAmount: () => number = () => 1,
  ) {
    super();

    this.getAttachmentPoint = getAttachmentPoint;
    this.getAttachmentVelocity = getAttachmentVelocity;
    this.getHoistAmount = getHoistAmount;
    const attachPos = this.getAttachmentPoint();
    const segmentLength = TELLTAIL_LENGTH / (TELLTAIL_NODES - 1);

    // Create particle chain - initially laid out horizontally from attachment
    this.bodies = range(TELLTAIL_NODES).map((i) =>
      new DynamicBody({
        mass: TELLTAIL_NODE_MASS,
        position: attachPos.add([i * segmentLength, 0]),
        collisionResponse: false,
        fixedRotation: true,
      }).addShape(new Particle()),
    );

    // Connect adjacent particles with distance constraints
    this.constraints = pairs(this.bodies).map(
      ([a, b]) =>
        new DistanceConstraint(a, b, {
          distance: segmentLength * SLACK_FACTOR,
          collideConnected: false,
        }),
    );

    // Wind query for body positions (skip first which is attached)
    this.windQuery = this.addChild(
      new WindQuery(() => this.getWindQueryPoints()),
    );
  }

  /**
   * Get points to query for wind data at each body position (except first).
   */
  private getWindQueryPoints(): V2d[] {
    const points: V2d[] = [];
    for (let i = 1; i < this.bodies.length; i++) {
      points.push(V(this.bodies[i].position));
    }
    return points;
  }

  @on("tick")
  onTick() {
    // Manually position first particle to follow the sail (one-way coupling)
    const firstBody = this.bodies[0];
    firstBody.position.set(this.getAttachmentPoint());
    firstBody.velocity.set(this.getAttachmentVelocity());

    // Need wind query results (1-frame latency)
    if (this.windQuery.results.length === 0) return;

    const drag = flatPlateDrag(DRAG_SCALE);

    // Apply wind forces to all particles except the first (which is fixed to sail)
    for (let i = 1; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const bodyPos = body.position;

      // Get previous and next positions for edge calculation
      const prevPos =
        i === 0 ? this.getAttachmentPoint() : this.bodies[i - 1].position;
      const nextPos =
        i === this.bodies.length - 1
          ? bodyPos.add(bodyPos.sub(prevPos).normalize()) // Extrapolate past end
          : this.bodies[i + 1].position;

      // Virtual edge from prev to next, expressed in body-local coordinates
      const v1Local = prevPos.sub(bodyPos);
      const v2Local = nextPos.sub(bodyPos);

      // Get wind velocity from query results (index is i-1 since we skip first body)
      const windResult = this.windQuery.results[i - 1];
      const getFluidVelocity = (_point: V2d): V2d => windResult.velocity;

      applyFluidForces(body, v1Local, v2Local, noLift, drag, getFluidVelocity);
      applyFluidForces(body, v2Local, v1Local, noLift, drag, getFluidVelocity);
    }
  }

  @on("render")
  onRender({ draw }: { draw: import("../../../core/graphics/Draw").Draw }) {
    if (this.bodies.length < 2) return;

    // Match sail's fade behavior: fade when hoistAmount < 0.4
    const fadeStart = 0.4;
    const hoistAmount = this.getHoistAmount();
    const alpha =
      hoistAmount >= fadeStart ? 1 : (hoistAmount / fadeStart) ** 0.5;

    const vertices = this.bodies.map((b) => b.position.clone());

    draw.spline(vertices, {
      color: TELLTAIL_COLOR,
      width: TELLTAIL_WIDTH,
      alpha,
    });
  }
}
