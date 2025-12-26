import { Body, LinearSpring, Particle } from "p2";
import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { last, pairs, range } from "../../core/util/FunctionalUtils";
import { degToRad, lerpV2d } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import {
  applyFluidForces,
  ForceMagnitudeFn,
  GLOBAL_FORCE_SCALE,
} from "../lift-and-drag";
import { Wind } from "../Wind";
import { Rig } from "./Rig";

const SAIL_NODES = 16;
const LIFT_SCALE = 0.5;
const DRAG_SCALE = 0.6;
const CAMBER_LIFT_FACTOR = 2.0; // How much camber increases lift
const SAIL_STIFFNESS = 200;
const SAIL_DAMPING = 2;
const STALL_ANGLE = degToRad(15);

export class Sail extends BaseEntity {
  sprite: GameSprite & Graphics;
  bodies: NonNullable<BaseEntity["bodies"]>;
  springs: NonNullable<BaseEntity["springs"]>;

  constructor(private rig: Rig) {
    super();

    this.sprite = createGraphics("sails");

    this.bodies = [];
    this.springs = [];
  }

  onAdd() {
    const start = this.rig.getMastWorldPosition();
    const end = this.rig.getBoomEndWorldPosition();
    this.bodies = range(SAIL_NODES).map((i) => {
      const t = i / (SAIL_NODES - 1);
      const body = new Body({
        mass: 0.1,
        position: lerpV2d(start, end, t),
        collisionResponse: false,
        fixedRotation: true,
      });
      body.addShape(new Particle());
      return body;
    });

    const springConfig = {
      stiffness: SAIL_STIFFNESS,
      damping: SAIL_DAMPING,
    };

    for (const [a, b] of pairs(this.bodies)) {
      this.springs.push(new LinearSpring(a, b, springConfig));
    }
    // Attach first particle to boom at mast (pivot point)
    this.springs.push(
      new LinearSpring(this.rig.body, this.bodies[0], {
        ...springConfig,
        localAnchorA: [0, 0],
      })
    );
    // Attach last particle to boom end
    this.springs.push(
      new LinearSpring(this.rig.body, last(this.bodies), {
        ...springConfig,
        localAnchorA: [-this.rig.getBoomLength(), 0],
      })
    );
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

    // Outside of sail
    this.sprite.moveTo(start.x, start.y);
    for (const body of this.bodies) {
      const [x, y] = body.position;
      this.sprite.lineTo(x, y);
    }
    this.sprite.lineTo(end.x, end.y);
    // Inside
    for (const [i, body] of this.bodies.toReversed().entries()) {
      const t = i / (this.bodies.length - 1);
      const boomPosition = lerpV2d(end, start, t);
      const [x, y] = lerpV2d(boomPosition, body.position, 0.3);
      this.sprite.lineTo(x, y);
    }

    this.sprite
      .fill({ color: 0xeeeeff })
      .stroke({ color: 0xeeeeff, join: "round", width: 1 });
  }
}

// ============================================================================
// Sail Airfoil Physics
// ============================================================================

/**
 * Calculate camber from three points (prev, current, next).
 * Returns how far the middle point deviates from the chord line,
 * normalized by chord length. Positive = curved toward the normal.
 */
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

/**
 * Create a lift magnitude function for sail airfoil behavior.
 * Unlike flat plates, airfoil lift is proportional to sin(α) * Cl(α),
 * not sin(α) * cos(α). Camber increases lift coefficient.
 */
function sailLift(scale: number, camber: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    const alpha = Math.abs(angleOfAttack);

    // Lift coefficient: linear region up to stall, then exponential decay
    let cl: number;
    if (alpha < STALL_ANGLE) {
      cl = 2 * Math.PI * Math.sin(alpha) * Math.sign(angleOfAttack);
    } else {
      const peak = 2 * Math.PI * Math.sin(STALL_ANGLE);
      const decay = Math.exp(-3 * (alpha - STALL_ANGLE));
      cl = peak * decay * Math.sign(angleOfAttack);
    }

    // Camber increases lift
    cl += Math.abs(camber) * CAMBER_LIFT_FACTOR;

    return (
      Math.sin(angleOfAttack) *
      cl *
      speed *
      speed *
      edgeLength *
      scale *
      GLOBAL_FORCE_SCALE
    );
  };
}

/**
 * Create a drag magnitude function for sail airfoil behavior.
 */
function sailDrag(scale: number): ForceMagnitudeFn {
  return ({ angleOfAttack, speed, edgeLength }) => {
    const alpha = Math.abs(angleOfAttack);

    // Drag coefficient: base + induced + stall penalty
    const baseDrag = 0.02;
    const inducedDrag = 0.1 * alpha * alpha;
    const stallDrag = alpha > STALL_ANGLE ? 0.5 * (alpha - STALL_ANGLE) : 0;
    const cd = baseDrag + inducedDrag + stallDrag;

    return (
      Math.sin(angleOfAttack) *
      cd *
      speed *
      speed *
      edgeLength *
      scale *
      GLOBAL_FORCE_SCALE
    );
  };
}
