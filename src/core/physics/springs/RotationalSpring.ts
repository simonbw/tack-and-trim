import type Body from "../body/Body";
import Spring, { SpringOptions } from "./Spring";

export interface RotationalSpringOptions extends SpringOptions {
  restAngle?: number;
}

/**
 * A rotational spring, connecting two bodies rotation.
 */
export default class RotationalSpring extends Spring {
  restAngle: number;

  constructor(bodyA: Body, bodyB: Body, options: RotationalSpringOptions = {}) {
    super(bodyA, bodyB, options);

    this.restAngle =
      typeof options.restAngle === "number"
        ? options.restAngle
        : bodyB.angle - bodyA.angle;
  }

  applyForce(): void {
    const k = this.stiffness;
    const d = this.damping;
    const l = this.restAngle;
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const x = bodyB.angle - bodyA.angle;
    const u = bodyB.angularVelocity - bodyA.angularVelocity;

    const torque = -k * (x - l) - d * u * 0;

    bodyA.angularForce -= torque;
    bodyB.angularForce += torque;
  }
}
