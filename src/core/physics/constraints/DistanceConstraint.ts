import { CompatibleVector, V, V2d } from "../../Vector";
import type Body from "../body/Body";
import Equation from "../equations/Equation";
import Constraint, { ConstraintOptions } from "./Constraint";

export interface DistanceConstraintOptions extends ConstraintOptions {
  distance?: number;
  localAnchorA?: CompatibleVector;
  localAnchorB?: CompatibleVector;
  maxForce?: number;
}

/** Constraint that tries to keep the distance between two bodies constant. */
export default class DistanceConstraint extends Constraint {
  /** Local anchor in body A. */
  localAnchorA: V2d;

  /** Local anchor in body B. */
  localAnchorB: V2d;

  /** The distance to keep. */
  distance: number;

  /** Max force to apply. */
  maxForce: number;

  /** If the upper limit is enabled or not. */
  upperLimitEnabled: boolean = false;

  /** The upper constraint limit. */
  upperLimit: number = 1;

  /** If the lower limit is enabled or not. */
  lowerLimitEnabled: boolean = false;

  /** The lower constraint limit. */
  lowerLimit: number = 0;

  /**
   * Current constraint position. This is equal to the current distance
   * between the world anchor points.
   */
  position: number = 0;

  constructor(
    bodyA: Body,
    bodyB: Body,
    options: DistanceConstraintOptions = {}
  ) {
    super(bodyA, bodyB, options);

    const localAnchorAOpt = options?.localAnchorA ?? [0, 0];
    const localAnchorBOpt = options?.localAnchorB ?? [0, 0];

    this.localAnchorA = V(localAnchorAOpt[0], localAnchorAOpt[1]);
    this.localAnchorB = V(localAnchorBOpt[0], localAnchorBOpt[1]);

    const localAnchorA = this.localAnchorA;
    const localAnchorB = this.localAnchorB;

    this.distance = 0;

    if (typeof options.distance === "number") {
      this.distance = options.distance;
    } else {
      // Use the current world distance between the world anchor points.
      const worldAnchorA = V();
      const worldAnchorB = V();
      const r = V();

      // Transform local anchors to world
      worldAnchorA.set(localAnchorA).irotate(bodyA.angle);
      worldAnchorB.set(localAnchorB).irotate(bodyB.angle);

      r.set(bodyB.position)
        .iadd(worldAnchorB)
        .isub(worldAnchorA)
        .isub(bodyA.position);

      this.distance = r.magnitude;
    }

    let maxForce: number;
    if (typeof options.maxForce === "undefined") {
      maxForce = Number.MAX_VALUE;
    } else {
      maxForce = options.maxForce;
    }

    const that = this;
    const normal = new Equation(bodyA, bodyB, -maxForce, maxForce);

    // Custom computeGq for this constraint
    const riLocal = V();
    const rjLocal = V();
    const rLocal = V();
    normal.computeGq = function () {
      const bodyA = this.bodyA;
      const bodyB = this.bodyB;
      const xi = bodyA.position;
      const xj = bodyB.position;

      // Transform local anchors to world
      riLocal.set(localAnchorA).irotate(bodyA.angle);
      rjLocal.set(localAnchorB).irotate(bodyB.angle);

      rLocal.set(xj).iadd(rjLocal).isub(riLocal).isub(xi);

      return rLocal.magnitude - that.distance;
    };

    this.equations = [normal];
    this.maxForce = maxForce;

    // Make the contact constraint bilateral
    this.setMaxForce(maxForce);
  }

  /**
   * Update the constraint equations. Should be done if any of the bodies
   * changed position, before solving.
   */
  update(): this {
    const normal = this.equations[0];
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const xi = bodyA.position;
    const xj = bodyB.position;
    const normalEquation = this.equations[0];
    const G = normal.G;

    // Transform local anchors to world
    const ri = this.localAnchorA.rotate(bodyA.angle);
    const rj = this.localAnchorB.rotate(bodyB.angle);

    // Get world anchor points and normal
    const n = xj.add(rj).sub(ri).sub(xi);
    this.position = n.magnitude;

    let violating = false;
    if (this.upperLimitEnabled) {
      if (this.position > this.upperLimit) {
        normalEquation.maxForce = 0;
        normalEquation.minForce = -this.maxForce;
        this.distance = this.upperLimit;
        violating = true;
      }
    }

    if (this.lowerLimitEnabled) {
      if (this.position < this.lowerLimit) {
        normalEquation.maxForce = this.maxForce;
        normalEquation.minForce = 0;
        this.distance = this.lowerLimit;
        violating = true;
      }
    }

    if ((this.lowerLimitEnabled || this.upperLimitEnabled) && !violating) {
      // No constraint needed.
      normalEquation.enabled = false;
      return this;
    }

    normalEquation.enabled = true;

    const nNormalized = n.normalize();

    // Calculate cross products
    const rixn = ri.crossLength(nNormalized);
    const rjxn = rj.crossLength(nNormalized);

    // G = [-n -rixn n rjxn]
    G[0] = -nNormalized[0];
    G[1] = -nNormalized[1];
    G[2] = -rixn;
    G[3] = nNormalized[0];
    G[4] = nNormalized[1];
    G[5] = rjxn;

    return this;
  }

  /** Set the max force to be used */
  setMaxForce(maxForce: number): void {
    const normal = this.equations[0];
    normal.minForce = -maxForce;
    normal.maxForce = maxForce;
  }

  /** Get the max force */
  getMaxForce(): number {
    const normal = this.equations[0];
    return normal.maxForce;
  }
}
