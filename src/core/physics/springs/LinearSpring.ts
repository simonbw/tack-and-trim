import { CompatibleVector, V, V2d } from "../../Vector";
import type Body from "../body/Body";
import Spring, { SpringOptions } from "./Spring";

export interface LinearSpringOptions extends SpringOptions {
  restLength?: number;
  localAnchorA?: CompatibleVector;
  localAnchorB?: CompatibleVector;
  worldAnchorA?: CompatibleVector;
  worldAnchorB?: CompatibleVector;
}

const applyForce_r = V();
const applyForce_r_unit = V();
const applyForce_u = V();
const applyForce_f = V();
const applyForce_worldAnchorA = V();
const applyForce_worldAnchorB = V();
const applyForce_ri = V();
const applyForce_rj = V();
const applyForce_tmp = V();

/**
 * A spring, connecting two bodies.
 */
export default class LinearSpring extends Spring {
  localAnchorA: V2d;
  localAnchorB: V2d;
  restLength: number;

  constructor(bodyA: Body, bodyB: Body, options: LinearSpringOptions = {}) {
    super(bodyA, bodyB, options);

    this.localAnchorA = V();
    this.localAnchorB = V();

    if (options.localAnchorA) {
      this.localAnchorA.set(options.localAnchorA);
    }
    if (options.localAnchorB) {
      this.localAnchorB.set(options.localAnchorB);
    }
    if (options.worldAnchorA) {
      this.setWorldAnchorA(options.worldAnchorA);
    }
    if (options.worldAnchorB) {
      this.setWorldAnchorB(options.worldAnchorB);
    }

    const worldAnchorA = V();
    const worldAnchorB = V();
    this.getWorldAnchorA(worldAnchorA);
    this.getWorldAnchorB(worldAnchorB);
    const worldDistance = worldAnchorA.distanceTo(worldAnchorB);

    this.restLength =
      typeof options.restLength === "number"
        ? options.restLength
        : worldDistance;
  }

  setWorldAnchorA(worldAnchorA: CompatibleVector): void {
    const anchor = V(worldAnchorA[0], worldAnchorA[1]);
    this.bodyA.toLocalFrame(this.localAnchorA, anchor);
  }

  setWorldAnchorB(worldAnchorB: CompatibleVector): void {
    const anchor = V(worldAnchorB[0], worldAnchorB[1]);
    this.bodyB.toLocalFrame(this.localAnchorB, anchor);
  }

  getWorldAnchorA(result: V2d): void {
    this.bodyA.toWorldFrame(result, this.localAnchorA);
  }

  getWorldAnchorB(result: V2d): void {
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
    ri.set(worldAnchorA).isub(bodyA.position);
    rj.set(worldAnchorB).isub(bodyB.position);

    // Compute distance vector between world anchor points
    r.set(worldAnchorB).isub(worldAnchorA);
    const rlen = r.magnitude;
    r_unit.set(r).inormalize();

    // Compute relative velocity of the anchor points, u
    u.set(bodyB.velocity).isub(bodyA.velocity);
    tmp.set(rj).icrossZV(bodyB.angularVelocity);
    u.iadd(tmp);
    tmp.set(ri).icrossZV(bodyA.angularVelocity);
    u.isub(tmp);

    // F = - k * ( x - L ) - D * ( u )
    f.set(r_unit).imul(-k * (rlen - l) - d * u.dot(r_unit));

    // Add forces to bodies
    bodyA.force.isub(f);
    bodyB.force.iadd(f);

    // Angular force
    const ri_x_f = ri.crossLength(f);
    const rj_x_f = rj.crossLength(f);
    bodyA.angularForce -= ri_x_f;
    bodyB.angularForce += rj_x_f;
  }
}
