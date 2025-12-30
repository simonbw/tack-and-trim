import LinearSpring from "./LinearSpring";
import { V2d } from "../../Vector";

// Module-level temp vectors for zero-allocation physics calculations
const _r = new V2d(0, 0);
const _rUnit = new V2d(0, 0);
const _u = new V2d(0, 0);
const _f = new V2d(0, 0);
const _worldAnchorA = new V2d(0, 0);
const _worldAnchorB = new V2d(0, 0);
const _ri = new V2d(0, 0);
const _rj = new V2d(0, 0);
const _tmp = new V2d(0, 0);

/**
 * A spring that only applies force when stretched, not when compressed.
 * Useful for rope/cable physics where slack is allowed.
 */
export default class RopeSpring extends LinearSpring {
  applyForce() {
    const k = this.stiffness;
    const d = this.damping;
    const l = this.restLength;
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;

    // Get world anchors
    this.getWorldAnchorA(_worldAnchorA);
    this.getWorldAnchorB(_worldAnchorB);

    // Get offset points
    _ri.set(_worldAnchorA).isub(bodyA.position);
    _rj.set(_worldAnchorB).isub(bodyB.position);

    // Compute distance vector between world anchor points
    _r.set(_worldAnchorB).isub(_worldAnchorA);
    const rlen = _r.magnitude;

    // Only apply force if we're beyond the length
    if (rlen > l) {
      _rUnit.set(_r).inormalize();

      // Compute relative velocity of the anchor points, u
      _u.set(bodyB.velocity).isub(bodyA.velocity);
      _tmp.set(_rj).icrossZV(bodyB.angularVelocity);
      _u.iadd(_tmp);
      _tmp.set(_ri).icrossZV(bodyA.angularVelocity);
      _u.isub(_tmp);

      // F = - k * ( x - L ) - D * ( u )
      _f.set(_rUnit).imul(-k * (rlen - l) - d * _u.dot(_rUnit));

      // Clamp force magnitude to prevent instability
      const maxForce = 200;
      const forceMag = _f.magnitude;
      if (forceMag > maxForce) {
        _f.imul(maxForce / forceMag);
      }

      // Add forces to bodies
      bodyA.force.isub(_f);
      bodyB.force.iadd(_f);

      // Angular force
      const riCrossF = _ri.crossLength(_f);
      const rjCrossF = _rj.crossLength(_f);
      bodyA.angularForce -= riCrossF;
      bodyB.angularForce += rjCrossF;
    }
  }
}
