import vec2, { Vec2 } from "../math/vec2";
import Spring, { SpringOptions } from "./Spring";
import type Body from "./Body";

export interface LinearSpringOptions extends SpringOptions {
  restLength?: number;
  localAnchorA?: Vec2;
  localAnchorB?: Vec2;
  worldAnchorA?: Vec2;
  worldAnchorB?: Vec2;
}

const applyForce_r = vec2.create();
const applyForce_r_unit = vec2.create();
const applyForce_u = vec2.create();
const applyForce_f = vec2.create();
const applyForce_worldAnchorA = vec2.create();
const applyForce_worldAnchorB = vec2.create();
const applyForce_ri = vec2.create();
const applyForce_rj = vec2.create();
const applyForce_tmp = vec2.create();

/**
 * A spring, connecting two bodies.
 */
export default class LinearSpring extends Spring {
  localAnchorA: Vec2;
  localAnchorB: Vec2;
  restLength: number;

  constructor(bodyA: Body, bodyB: Body, options: LinearSpringOptions = {}) {
    super(bodyA, bodyB, options);

    this.localAnchorA = vec2.fromValues(0, 0);
    this.localAnchorB = vec2.fromValues(0, 0);

    if (options.localAnchorA) {
      vec2.copy(this.localAnchorA, options.localAnchorA);
    }
    if (options.localAnchorB) {
      vec2.copy(this.localAnchorB, options.localAnchorB);
    }
    if (options.worldAnchorA) {
      this.setWorldAnchorA(options.worldAnchorA);
    }
    if (options.worldAnchorB) {
      this.setWorldAnchorB(options.worldAnchorB);
    }

    const worldAnchorA = vec2.create();
    const worldAnchorB = vec2.create();
    this.getWorldAnchorA(worldAnchorA);
    this.getWorldAnchorB(worldAnchorB);
    const worldDistance = vec2.distance(worldAnchorA, worldAnchorB);

    this.restLength =
      typeof options.restLength === "number"
        ? options.restLength
        : worldDistance;
  }

  setWorldAnchorA(worldAnchorA: Vec2): void {
    this.bodyA.toLocalFrame(this.localAnchorA, worldAnchorA);
  }

  setWorldAnchorB(worldAnchorB: Vec2): void {
    this.bodyB.toLocalFrame(this.localAnchorB, worldAnchorB);
  }

  getWorldAnchorA(result: Vec2): void {
    this.bodyA.toWorldFrame(result, this.localAnchorA);
  }

  getWorldAnchorB(result: Vec2): void {
    this.bodyB.toWorldFrame(result, this.localAnchorB);
  }

  applyForce(): void {
    const k = this.stiffness;
    const d = this.damping;
    const l = this.restLength;
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const r = applyForce_r;
    const r_unit = applyForce_r_unit;
    const u = applyForce_u;
    const f = applyForce_f;
    const tmp = applyForce_tmp;

    const worldAnchorA = applyForce_worldAnchorA;
    const worldAnchorB = applyForce_worldAnchorB;
    const ri = applyForce_ri;
    const rj = applyForce_rj;

    // Get world anchors
    this.getWorldAnchorA(worldAnchorA);
    this.getWorldAnchorB(worldAnchorB);

    // Get offset points
    vec2.sub(ri, worldAnchorA, bodyA.position);
    vec2.sub(rj, worldAnchorB, bodyB.position);

    // Compute distance vector between world anchor points
    vec2.sub(r, worldAnchorB, worldAnchorA);
    const rlen = vec2.len(r);
    vec2.normalize(r_unit, r);

    // Compute relative velocity of the anchor points, u
    vec2.sub(u, bodyB.velocity, bodyA.velocity);
    vec2.crossZV(tmp, bodyB.angularVelocity, rj);
    vec2.add(u, u, tmp);
    vec2.crossZV(tmp, bodyA.angularVelocity, ri);
    vec2.sub(u, u, tmp);

    // F = - k * ( x - L ) - D * ( u )
    vec2.scale(f, r_unit, -k * (rlen - l) - d * vec2.dot(u, r_unit));

    // Add forces to bodies
    vec2.sub(bodyA.force, bodyA.force, f);
    vec2.add(bodyB.force, bodyB.force, f);

    // Angular force
    const ri_x_f = vec2.crossLength(ri, f);
    const rj_x_f = vec2.crossLength(rj, f);
    bodyA.angularForce -= ri_x_f;
    bodyB.angularForce += rj_x_f;
  }
}
