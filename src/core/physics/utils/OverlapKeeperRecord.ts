import type Body from "../body/Body";
import type Shape from "../shapes/Shape";

/**
 * Overlap data container for the OverlapKeeper
 */
export default class OverlapKeeperRecord {
  shapeA: Shape | null;
  shapeB: Shape | null;
  bodyA: Body | null;
  bodyB: Body | null;

  constructor(
    bodyA: Body | null = null,
    shapeA: Shape | null = null,
    bodyB: Body | null = null,
    shapeB: Shape | null = null
  ) {
    this.shapeA = shapeA;
    this.shapeB = shapeB;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
  }

  set(bodyA: Body, shapeA: Shape, bodyB: Body, shapeB: Shape): void {
    this.bodyA = bodyA;
    this.shapeA = shapeA;
    this.bodyB = bodyB;
    this.shapeB = shapeB;
  }
}
