import BaseEntity from "../../core/entity/BaseEntity";
import Body from "../../core/physics/body/Body";
import DynamicBody from "../../core/physics/body/DynamicBody";
import DistanceConstraint from "../../core/physics/constraints/DistanceConstraint";
import Particle from "../../core/physics/shapes/Particle";
import { pairs, range } from "../../core/util/FunctionalUtils";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForces,
  flatPlateDrag,
  ForceMagnitudeFn,
} from "../fluid-dynamics";
import type { Wind } from "../Wind";

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

  constructor(private attachmentBody: Body) {
    super();

    this.bodies = [];
    this.constraints = [];
  }

  onAdd() {
    const attachPos = V(this.attachmentBody.position);
    const segmentLength = TELLTAIL_LENGTH / (TELLTAIL_NODES - 1);

    // Create particle chain - initially laid out horizontally from attachment
    this.bodies = range(TELLTAIL_NODES).map((i) => {
      const body = new DynamicBody({
        mass: TELLTAIL_NODE_MASS,
        position: [attachPos.x + i * segmentLength, attachPos.y],
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
          distance: segmentLength * SLACK_FACTOR,
          collideConnected: false,
        })
      );
    }

    // Note: First particle is manually positioned in onTick to follow the sail
    // without exerting forces back on it (one-way coupling). Since we set its
    // position directly, the constraint between particles 0-1 only affects
    // particle 1, not particle 0.
  }

  onTick() {
    // Manually position first particle to follow the sail (one-way coupling)
    const firstBody = this.bodies[0];
    firstBody.position[0] = this.attachmentBody.position[0];
    firstBody.position[1] = this.attachmentBody.position[1];
    firstBody.velocity[0] = this.attachmentBody.velocity[0];
    firstBody.velocity[1] = this.attachmentBody.velocity[1];

    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    const getFluidVelocity = (point: V2d): V2d =>
      wind.getVelocityAtPoint(point);

    const drag = flatPlateDrag(DRAG_SCALE);

    // Apply wind forces to all particles except the first (which is fixed to sail)
    for (let i = 1; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const bodyPos = V(body.position);

      // Get previous and next positions for edge calculation
      const prevPos =
        i === 0
          ? V(this.attachmentBody.position)
          : V(this.bodies[i - 1].position);
      const nextPos =
        i === this.bodies.length - 1
          ? bodyPos.add(bodyPos.sub(prevPos).normalize()) // Extrapolate past end
          : V(this.bodies[i + 1].position);

      // Virtual edge from prev to next, expressed in body-local coordinates
      const v1Local = prevPos.sub(bodyPos);
      const v2Local = nextPos.sub(bodyPos);

      applyFluidForces(body, v1Local, v2Local, noLift, drag, getFluidVelocity);
      applyFluidForces(body, v2Local, v1Local, noLift, drag, getFluidVelocity);
    }
  }

  onRender() {
    if (this.bodies.length < 2) return;

    const renderer = this.game!.getRenderer();

    // Draw using path API
    renderer.beginPath();
    const [startX, startY] = this.bodies[0].position;
    renderer.moveTo(startX, startY);

    for (let i = 1; i < this.bodies.length; i++) {
      const [x, y] = this.bodies[i].position;
      renderer.lineTo(x, y);
    }

    renderer.stroke(TELLTAIL_COLOR, TELLTAIL_WIDTH, 1.0, false);
  }
}
