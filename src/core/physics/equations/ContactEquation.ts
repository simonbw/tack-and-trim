import { V, V2d } from "../../Vector";
import type Body from "../body/Body";
import type Shape from "../shapes/Shape";
import type { SolverBodyState } from "../solver/GSSolver";
import Equation from "./Equation";

/**
 * Non-penetration constraint equation. Tries to make the contactPointA and
 * contactPointB vectors coincide, while keeping the applied force repulsive.
 */
export default class ContactEquation extends Equation {
  /**
   * Vector from body i center of mass to the contact point.
   */
  contactPointA: V2d;
  penetrationVec: V2d;

  /**
   * World-oriented vector from body A center of mass to the contact point.
   */
  contactPointB: V2d;

  /**
   * The normal vector, pointing out of body i
   */
  normalA: V2d;

  /**
   * The restitution to use (0=no bounciness, 1=max bounciness).
   */
  restitution: number = 0;

  /**
   * This property is set to true if this is the first impact between the bodies
   * (not persistant contact).
   */
  firstImpact: boolean = false;

  /**
   * The shape in body i that triggered this contact.
   */
  shapeA: Shape | null = null;

  /**
   * The shape in body j that triggered this contact.
   */
  shapeB: Shape | null = null;

  constructor(bodyA: Body, bodyB: Body) {
    super(bodyA, bodyB, 0, Number.MAX_VALUE);

    this.contactPointA = V();
    this.penetrationVec = V();
    this.contactPointB = V();
    this.normalA = V();
  }

  computeB(
    a: number,
    b: number,
    h: number,
    bodyState: Map<Body, SolverBodyState>,
  ): number {
    const bi = this.bodyA;
    const bj = this.bodyB;
    const ri = this.contactPointA;
    const rj = this.contactPointB;
    const xi = bi.position;
    const xj = bj.position;

    const penetrationVec = this.penetrationVec;
    const n = this.normalA;
    const G = this.G;

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

    // Calculate q = xj+rj -(xi+ri) i.e. the penetration vector
    penetrationVec.set(xj).iadd(rj).isub(xi).isub(ri);

    // Compute iteration
    let GW: number;
    let Gq: number;
    if (this.firstImpact && this.restitution !== 0) {
      Gq = 0;
      GW = (1 / b) * (1 + this.restitution) * this.computeGW();
    } else {
      Gq = n.dot(penetrationVec) + this.offset;
      GW = this.computeGW();
    }

    const GiMf = this.computeGiMf(bodyState);
    const B = -Gq * a - GW * b - h * GiMf;

    return B;
  }

  /**
   * Get the relative velocity along the normal vector.
   */
  getVelocityAlongNormal(): number {
    const vi = this.bodyA.getVelocityAtPoint(this.contactPointA);
    const vj = this.bodyB.getVelocityAtPoint(this.contactPointB);
    const relVel = vi.isub(vj);

    return this.normalA.dot(relVel);
  }
}
