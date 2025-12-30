import { V2d } from "../../Vector";
import type Body from "../body/Body";
import type Shape from "../shapes/Shape";
import type ContactEquation from "./ContactEquation";
import Equation from "./Equation";

/**
 * Constrains the slipping in a contact along a tangent
 */
export default class FrictionEquation extends Equation {
  /**
   * Relative vector from center of body A to the contact point, world oriented.
   */
  contactPointA: V2d;

  /**
   * Relative vector from center of body B to the contact point, world oriented.
   */
  contactPointB: V2d;

  /**
   * Tangent vector that the friction force will act along. World oriented.
   */
  t: V2d;

  /**
   * ContactEquations connected to this friction equation. The contact equations
   * can be used to rescale the max force for the friction. If more than one
   * contact equation is given, then the max force can be set to the average.
   */
  contactEquations: ContactEquation[] = [];

  /**
   * The shape in body i that triggered this friction.
   */
  shapeA: Shape | null = null;

  /**
   * The shape in body j that triggered this friction.
   */
  shapeB: Shape | null = null;

  /**
   * The friction coefficient to use.
   */
  frictionCoefficient: number = 0.3;

  constructor(bodyA: Body, bodyB: Body, slipForce: number = 0) {
    super(bodyA, bodyB, -slipForce, slipForce);

    this.contactPointA = new V2d(0, 0);
    this.contactPointB = new V2d(0, 0);
    this.t = new V2d(0, 0);
  }

  /**
   * Set the slipping condition for the constraint. The friction force cannot be
   * larger than this value.
   */
  setSlipForce(slipForce: number): void {
    this.maxForce = slipForce;
    this.minForce = -slipForce;
  }

  /**
   * Get the max force for the constraint.
   */
  getSlipForce(): number {
    return this.maxForce;
  }

  computeB(a: number, b: number, h: number): number {
    const ri = this.contactPointA;
    const rj = this.contactPointB;
    const t = this.t;
    const G = this.G;

    // G = [-t -rixt t rjxt]
    // And remember, this is a pure velocity constraint, g is always zero!
    G[0] = -t[0];
    G[1] = -t[1];
    G[2] = -ri.crossLength(t);
    G[3] = t[0];
    G[4] = t[1];
    G[5] = rj.crossLength(t);

    const GW = this.computeGW();
    const GiMf = this.computeGiMf();

    const B = /* - g * a  */ -GW * b - h * GiMf;

    return B;
  }
}
