import LinearSpring from "./objects/LinearSpring";
import vec2 from "./math/vec2";

// Module-level temp vectors for zero-allocation physics calculations
const _r = vec2.create();
const _rUnit = vec2.create();
const _u = vec2.create();
const _f = vec2.create();
const _worldAnchorA = vec2.create();
const _worldAnchorB = vec2.create();
const _ri = vec2.create();
const _rj = vec2.create();
const _tmp = vec2.create();

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
    vec2.sub(_ri, _worldAnchorA, bodyA.position);
    vec2.sub(_rj, _worldAnchorB, bodyB.position);

    // Compute distance vector between world anchor points
    vec2.sub(_r, _worldAnchorB, _worldAnchorA);
    const rlen = vec2.len(_r);

    // Only apply force if we're beyond the length
    if (rlen > l) {
      vec2.normalize(_rUnit, _r);

      // Compute relative velocity of the anchor points, u
      vec2.sub(_u, bodyB.velocity, bodyA.velocity);
      vec2.crossZV(_tmp, bodyB.angularVelocity, _rj);
      vec2.add(_u, _u, _tmp);
      vec2.crossZV(_tmp, bodyA.angularVelocity, _ri);
      vec2.sub(_u, _u, _tmp);

      // F = - k * ( x - L ) - D * ( u )
      vec2.scale(_f, _rUnit, -k * (rlen - l) - d * vec2.dot(_u, _rUnit));

      // Clamp force magnitude to prevent instability
      const maxForce = 200;
      const forceMag = vec2.len(_f);
      if (forceMag > maxForce) {
        vec2.scale(_f, _f, maxForce / forceMag);
      }

      // Add forces to bodies
      vec2.sub(bodyA.force, bodyA.force, _f);
      vec2.add(bodyB.force, bodyB.force, _f);

      // Angular force
      const riCrossF = vec2.crossLength(_ri, _f);
      const rjCrossF = vec2.crossLength(_rj, _f);
      bodyA.angularForce -= riCrossF;
      bodyB.angularForce += rjCrossF;
    }
  }
}
