import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
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

// TellTail dimensions
const TELLTAIL_NODES = 6;
const TELLTAIL_NODE_MASS = 0.01;
const TELLTAIL_LENGTH = 6;
const SLACK_FACTOR = 1.02;

// Drag parameters
const DRAG_SCALE = 0.5;

// Rendering
const TELLTAIL_WIDTH = 1.5;
const TELLTAIL_COLOR = 0xff6600;

/** No lift for a thin streamer - it just gets pushed by the wind. */
const noLift: ForceMagnitudeFn = () => 0;

export class TellTail extends BaseEntity {
  sprite: GameSprite & Graphics;
  bodies: NonNullable<BaseEntity["bodies"]>;
  constraints: NonNullable<BaseEntity["constraints"]>;

  constructor(private attachmentBody: Body) {
    super();

    this.sprite = createGraphics("telltails");

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

    // Attach first particle to the sail body
    this.constraints.push(
      new DistanceConstraint(this.attachmentBody, this.bodies[0], {
        distance: 0,
        collideConnected: false,
        localAnchorA: [0, 0],
      })
    );
  }

  onTick() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    const getFluidVelocity = (point: V2d): V2d =>
      wind.getVelocityAtPoint([point.x, point.y]);

    const drag = flatPlateDrag(DRAG_SCALE);

    for (let i = 0; i < this.bodies.length; i++) {
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
    this.sprite.clear();

    if (this.bodies.length < 2) return;

    // Draw using moveTo/lineTo like Sail does
    const [startX, startY] = this.bodies[0].position;
    this.sprite.moveTo(startX, startY);

    for (let i = 1; i < this.bodies.length; i++) {
      const [x, y] = this.bodies[i].position;
      this.sprite.lineTo(x, y);
    }

    this.sprite.stroke({ color: TELLTAIL_COLOR, width: TELLTAIL_WIDTH });
  }
}
