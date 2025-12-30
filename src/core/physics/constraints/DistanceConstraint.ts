import { CompatibleVector, V2d } from "../../Vector";
import type Body from "../body/Body";
import Equation from "../equations/Equation";
import { defaults } from "../utils/Utils";
import Constraint, { ConstraintOptions } from "./Constraint";

export interface DistanceConstraintOptions extends ConstraintOptions {
  distance?: number;
  localAnchorA?: CompatibleVector;
  localAnchorB?: CompatibleVector;
  maxForce?: number;
}

// Module-level temp vectors
const n = new V2d(0, 0);
const ri = new V2d(0, 0);
const rj = new V2d(0, 0);

/**
 * Constraint that tries to keep the distance between two bodies constant.
 */
export default class DistanceConstraint extends Constraint {
  /**
   * Local anchor in body A.
   */
  localAnchorA: V2d;

  /**
   * Local anchor in body B.
   */
  localAnchorB: V2d;

  /**
   * The distance to keep.
   */
  distance: number;

  /**
   * Max force to apply.
   */
  maxForce: number;

  /**
   * If the upper limit is enabled or not.
   */
  upperLimitEnabled: boolean = false;

  /**
   * The upper constraint limit.
   */
  upperLimit: number = 1;

  /**
   * If the lower limit is enabled or not.
   */
  lowerLimitEnabled: boolean = false;

  /**
   * The lower constraint limit.
   */
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
    const opts = defaults(options, {
      localAnchorA: [0, 0] as CompatibleVector,
      localAnchorB: [0, 0] as CompatibleVector,
    });

    super(bodyA, bodyB, Constraint.DISTANCE, options);

    this.localAnchorA = new V2d(opts.localAnchorA[0], opts.localAnchorA[1]);
    this.localAnchorB = new V2d(opts.localAnchorB[0], opts.localAnchorB[1]);

    const localAnchorA = this.localAnchorA;
    const localAnchorB = this.localAnchorB;

    this.distance = 0;

    if (typeof options.distance === "number") {
      this.distance = options.distance;
    } else {
      // Use the current world distance between the world anchor points.
      const worldAnchorA = new V2d(0, 0);
      const worldAnchorB = new V2d(0, 0);
      const r = new V2d(0, 0);

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
    const riLocal = new V2d(0, 0);
    const rjLocal = new V2d(0, 0);
    const rLocal = new V2d(0, 0);
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
  update(): void {
    const normal = this.equations[0];
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const xi = bodyA.position;
    const xj = bodyB.position;
    const normalEquation = this.equations[0];
    const G = normal.G;

    // Transform local anchors to world
    ri.set(this.localAnchorA).irotate(bodyA.angle);
    rj.set(this.localAnchorB).irotate(bodyB.angle);

    // Get world anchor points and normal
    n.set(xj).iadd(rj).isub(ri).isub(xi);
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
      return;
    }

    normalEquation.enabled = true;

    n.inormalize();

    // Calculate cross products
    const rixn = ri.crossLength(n);
    const rjxn = rj.crossLength(n);

    // G = [-n -rixn n rjxn]
    G[0] = -n[0];
    G[1] = -n[1];
    G[2] = -rixn;
    G[3] = n[0];
    G[4] = n[1];
    G[5] = rjxn;
  }

  /**
   * Set the max force to be used
   */
  setMaxForce(maxForce: number): void {
    const normal = this.equations[0];
    normal.minForce = -maxForce;
    normal.maxForce = maxForce;
  }

  /**
   * Get the max force
   */
  getMaxForce(): number {
    const normal = this.equations[0];
    return normal.maxForce;
  }
}
