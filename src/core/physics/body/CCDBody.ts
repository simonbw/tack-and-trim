import { V2d } from "../../Vector";
import Ray from "../collision/Ray";
import RaycastResult from "../collision/RaycastResult";
import Body from "./Body";

const _result = new RaycastResult();
const _ray = new Ray({
  from: [0, 0],
  to: [0, 0],
  mode: Ray.CLOSEST,
  skipBackfaces: true,
});
const _end = new V2d(0, 0);
const _startToEnd = new V2d(0, 0);
const _rememberPosition = new V2d(0, 0);
const _integrateVelodt = new V2d(0, 0);

/**
 * A physics body with Continuous Collision Detection (CCD) support.
 * Uses ray-casting to detect potential collisions for high-speed objects.
 */
export default class CCDBody extends Body {
  integrateToTimeOfImpact(dt: number): boolean {
    if (
      this.ccdSpeedThreshold < 0 ||
      this.velocity.squaredMagnitude < Math.pow(this.ccdSpeedThreshold, 2)
    ) {
      return false;
    }

    _end.set(this.velocity).imul(dt).iadd(this.position);

    _startToEnd.set(_end).isub(this.position);
    const startToEndAngle = this.angularVelocity * dt;
    const len = _startToEnd.magnitude;

    let timeOfImpact = 1;
    let hit: Body | undefined;
    const self = this;

    _result.reset();
    _ray.callback = function (result: RaycastResult) {
      if (result.body === self) {
        return;
      }
      hit = result.body ?? undefined;
      result.getHitPoint(_end, _ray);
      _startToEnd.set(_end).isub(self.position);
      timeOfImpact = _startToEnd.magnitude / len;
      result.stop();
    };
    _ray.from.set(this.position);
    _ray.to.set(_end);
    _ray.collisionGroup = this.getCollisionGroup();
    _ray.collisionMask = this.getCollisionMask();
    _ray.update();
    this.world!.raycast(_result, _ray);

    if (!hit) {
      return false;
    }

    const rememberAngle = this.angle;
    _rememberPosition.set(this.position);

    // Got a start and end point. Approximate time of impact using binary search
    let iter = 0;
    let tmin = 0;
    let tmid = 0;
    let tmax = timeOfImpact;
    while (tmax >= tmin && iter < this.ccdIterations) {
      iter++;

      // calculate the midpoint
      tmid = (tmax - tmin) / 2;

      // Move the body to that point
      _integrateVelodt.set(_startToEnd).imul(timeOfImpact);
      this.position.set(_rememberPosition).iadd(_integrateVelodt);
      this.angle = rememberAngle + startToEndAngle * timeOfImpact;
      this.updateAABB();

      // check overlap
      const overlaps =
        this.aabb.overlaps(hit.aabb) &&
        this.world!.narrowphase.bodiesOverlap(this, hit);

      if (overlaps) {
        // change min to search upper interval
        tmin = tmid;
      } else {
        // change max to search lower interval
        tmax = tmid;
      }
    }

    timeOfImpact = tmid;

    this.position.set(_rememberPosition);
    this.angle = rememberAngle;

    // move to TOI
    _integrateVelodt.set(_startToEnd).imul(timeOfImpact);
    this.position.iadd(_integrateVelodt);
    if (!this.fixedRotation) {
      this.angle += startToEndAngle * timeOfImpact;
    }

    return true;
  }

  private getCollisionMask(): number {
    let mask = 0;
    for (const shape of this.shapes) {
      mask |= shape.collisionMask;
    }
    return mask;
  }

  private getCollisionGroup(): number {
    let group = 0;
    for (const shape of this.shapes) {
      group |= shape.collisionGroup;
    }
    return group;
  }
}
