import Constraint, { ConstraintOptions } from "./Constraint";
import Equation from "../equations/Equation";
import vec2, { Vec2 } from "../math/vec2";
import { defaults } from "../utils/Utils";
import type Body from "../objects/Body";

export interface DistanceConstraintOptions extends ConstraintOptions {
  distance?: number;
  localAnchorA?: Vec2;
  localAnchorB?: Vec2;
  maxForce?: number;
}

// Module-level temp vectors
const n = vec2.create();
const ri = vec2.create();
const rj = vec2.create();

/**
 * Constraint that tries to keep the distance between two bodies constant.
 */
export default class DistanceConstraint extends Constraint {
  /**
   * Local anchor in body A.
   */
  localAnchorA: Vec2;

  /**
   * Local anchor in body B.
   */
  localAnchorB: Vec2;

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

  constructor(bodyA: Body, bodyB: Body, options: DistanceConstraintOptions = {}) {
    const opts = defaults(options, {
      localAnchorA: [0, 0] as Vec2,
      localAnchorB: [0, 0] as Vec2,
    });

    super(bodyA, bodyB, Constraint.DISTANCE, options);

    this.localAnchorA = vec2.fromValues(opts.localAnchorA[0], opts.localAnchorA[1]);
    this.localAnchorB = vec2.fromValues(opts.localAnchorB[0], opts.localAnchorB[1]);

    const localAnchorA = this.localAnchorA;
    const localAnchorB = this.localAnchorB;

    this.distance = 0;

    if (typeof options.distance === "number") {
      this.distance = options.distance;
    } else {
      // Use the current world distance between the world anchor points.
      const worldAnchorA = vec2.create();
      const worldAnchorB = vec2.create();
      const r = vec2.create();

      // Transform local anchors to world
      vec2.rotate(worldAnchorA, localAnchorA, bodyA.angle);
      vec2.rotate(worldAnchorB, localAnchorB, bodyB.angle);

      vec2.add(r, bodyB.position, worldAnchorB);
      vec2.sub(r, r, worldAnchorA);
      vec2.sub(r, r, bodyA.position);

      this.distance = vec2.length(r);
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
    const riLocal = vec2.create();
    const rjLocal = vec2.create();
    const rLocal = vec2.create();
    normal.computeGq = function () {
      const bodyA = this.bodyA;
      const bodyB = this.bodyB;
      const xi = bodyA.position;
      const xj = bodyB.position;

      // Transform local anchors to world
      vec2.rotate(riLocal, localAnchorA, bodyA.angle);
      vec2.rotate(rjLocal, localAnchorB, bodyB.angle);

      vec2.add(rLocal, xj, rjLocal);
      vec2.sub(rLocal, rLocal, riLocal);
      vec2.sub(rLocal, rLocal, xi);

      return vec2.length(rLocal) - that.distance;
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
    vec2.rotate(ri, this.localAnchorA, bodyA.angle);
    vec2.rotate(rj, this.localAnchorB, bodyB.angle);

    // Get world anchor points and normal
    vec2.add(n, xj, rj);
    vec2.sub(n, n, ri);
    vec2.sub(n, n, xi);
    this.position = vec2.length(n);

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

    vec2.normalize(n, n);

    // Calculate cross products
    const rixn = vec2.crossLength(ri, n);
    const rjxn = vec2.crossLength(rj, n);

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
