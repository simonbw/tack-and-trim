import Constraint, { ConstraintOptions } from "./Constraint";
import Equation from "../equations/Equation";
import vec2, { Vec2 } from "../math/vec2";
import type Body from "../objects/Body";

export interface LockConstraintOptions extends ConstraintOptions {
  localOffsetB?: Vec2;
  localAngleB?: number;
  maxForce?: number;
}

// Module-level temp vectors
const l = vec2.create();
const r = vec2.create();
const t = vec2.create();
const xAxis = vec2.fromValues(1, 0);
const yAxis = vec2.fromValues(0, 1);

/**
 * Locks the relative position and rotation between two bodies.
 */
export default class LockConstraint extends Constraint {
  /**
   * The offset of bodyB in bodyA's frame.
   */
  localOffsetB: Vec2;

  /**
   * The offset angle of bodyB in bodyA's frame.
   */
  localAngleB: number;

  constructor(bodyA: Body, bodyB: Body, options: LockConstraintOptions = {}) {
    super(bodyA, bodyB, Constraint.LOCK, options);

    const maxForce =
      typeof options.maxForce === "undefined"
        ? Number.MAX_VALUE
        : options.maxForce;

    // Equations
    const x = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const y = new Equation(bodyA, bodyB, -maxForce, maxForce);
    const rot = new Equation(bodyA, bodyB, -maxForce, maxForce);

    const lLocal = vec2.create();
    const gLocal = vec2.create();
    const that = this;

    x.computeGq = function () {
      vec2.rotate(lLocal, that.localOffsetB, bodyA.angle);
      vec2.sub(gLocal, bodyB.position, bodyA.position);
      vec2.sub(gLocal, gLocal, lLocal);
      return gLocal[0];
    };

    y.computeGq = function () {
      vec2.rotate(lLocal, that.localOffsetB, bodyA.angle);
      vec2.sub(gLocal, bodyB.position, bodyA.position);
      vec2.sub(gLocal, gLocal, lLocal);
      return gLocal[1];
    };

    const rLocal = vec2.create();
    const tLocal = vec2.create();
    rot.computeGq = function () {
      vec2.rotate(rLocal, that.localOffsetB, bodyB.angle - that.localAngleB);
      vec2.scale(rLocal, rLocal, -1);
      vec2.sub(gLocal, bodyA.position, bodyB.position);
      vec2.add(gLocal, gLocal, rLocal);
      vec2.rotate(tLocal, rLocal, -Math.PI / 2);
      vec2.normalize(tLocal, tLocal);
      return vec2.dot(gLocal, tLocal);
    };

    this.localOffsetB = vec2.create();
    if (options.localOffsetB) {
      vec2.copy(this.localOffsetB, options.localOffsetB);
    } else {
      // Construct from current positions
      vec2.sub(this.localOffsetB, bodyB.position, bodyA.position);
      vec2.rotate(this.localOffsetB, this.localOffsetB, -bodyA.angle);
    }

    this.localAngleB = 0;
    if (typeof options.localAngleB === "number") {
      this.localAngleB = options.localAngleB;
    } else {
      // Construct
      this.localAngleB = bodyB.angle - bodyA.angle;
    }

    this.equations.push(x, y, rot);
    this.setMaxForce(maxForce);
  }

  /**
   * Set the maximum force to be applied.
   */
  setMaxForce(force: number): void {
    const eqs = this.equations;
    for (let i = 0; i < this.equations.length; i++) {
      eqs[i].maxForce = force;
      eqs[i].minForce = -force;
    }
  }

  /**
   * Get the max force.
   */
  getMaxForce(): number {
    return this.equations[0].maxForce;
  }

  update(): void {
    const x = this.equations[0];
    const y = this.equations[1];
    const rot = this.equations[2];
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;

    vec2.rotate(l, this.localOffsetB, bodyA.angle);
    vec2.rotate(r, this.localOffsetB, bodyB.angle - this.localAngleB);
    vec2.scale(r, r, -1);

    vec2.rotate(t, r, Math.PI / 2);
    vec2.normalize(t, t);

    x.G[0] = -1;
    x.G[1] = 0;
    x.G[2] = -vec2.crossLength(l, xAxis);
    x.G[3] = 1;

    y.G[0] = 0;
    y.G[1] = -1;
    y.G[2] = -vec2.crossLength(l, yAxis);
    y.G[4] = 1;

    rot.G[0] = -t[0];
    rot.G[1] = -t[1];
    rot.G[3] = t[0];
    rot.G[4] = t[1];
    rot.G[5] = vec2.crossLength(r, t);
  }
}
