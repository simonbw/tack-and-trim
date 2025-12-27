import { Body, DistanceConstraint, Particle } from "p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { last, pairs, range } from "../../core/util/FunctionalUtils";
import { degToRad, lerpV2d } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { applyFluidForces } from "../fluid-dynamics";
import { Wind } from "../Wind";
import { Rig } from "./Rig";
import { calculateCamber, sailDrag, sailLift } from "./sail-helpers";

const SAIL_NODES = 64;
const SAIL_NODE_MASS = 0.08;
const LIFT_SCALE = 0.0;
const DRAG_SCALE = 2.6;
const SLACK_FACTOR = 1.2;
export const CAMBER_LIFT_FACTOR = 0.0;
export const STALL_ANGLE = degToRad(15);

export class Sail extends BaseEntity {
  sprite: GameSprite & Graphics;
  bodies: NonNullable<BaseEntity["bodies"]>;
  constraints: NonNullable<BaseEntity["constraints"]>;

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
      const body = new Body({
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

      // Force decreases toward boom end because it's a traingular sail
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
  }

  onRender() {
    this.sprite.clear();
    const start = this.rig.getMastWorldPosition();
    const end = this.rig.getBoomEndWorldPosition();

    // Outside of sail - skip first and last bodies since they're constrained
    // to start/end positions, which avoids degenerate line segments
    this.sprite.moveTo(start.x, start.y);
    for (let i = 1; i < this.bodies.length - 1; i++) {
      const [x, y] = this.bodies[i].position;
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
      const [x, y] = lerpV2d(boomPosition, body.position, 0.3);
      this.sprite.lineTo(x, y);
    }

    this.sprite
      .closePath()
      .fill({ color: 0xeeeeff })
      .stroke({ color: 0xeeeeff, join: "round", width: 1 });
  }
}
