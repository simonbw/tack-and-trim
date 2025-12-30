import Body from "./objects/Body";
import RaycastResult from "./collision/RaycastResult";
import Ray from "./collision/Ray";
import vec2 from "./math/vec2";

const _result = new RaycastResult();
const _ray = new Ray({
  from: [0, 0],
  to: [0, 0],
  mode: Ray.CLOSEST,
  skipBackfaces: true,
});
const _end = vec2.create();
const _startToEnd = vec2.create();
const _rememberPosition = vec2.create();
const _integrateVelodt = vec2.create();

/**
 * A physics body with Continuous Collision Detection (CCD) support.
 * Uses ray-casting to detect potential collisions for high-speed objects.
 */
export default class CCDBody extends Body {
  integrateToTimeOfImpact(dt: number): boolean {
    if (
      this.ccdSpeedThreshold < 0 ||
      vec2.squaredLength(this.velocity) < Math.pow(this.ccdSpeedThreshold, 2)
    ) {
      return false;
    }

    vec2.scale(_end, this.velocity, dt);
    vec2.add(_end, _end, this.position);

    vec2.sub(_startToEnd, _end, this.position);
    const startToEndAngle = this.angularVelocity * dt;
    const len = vec2.length(_startToEnd);

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
      vec2.sub(_startToEnd, _end, self.position);
      timeOfImpact = vec2.length(_startToEnd) / len;
      result.stop();
    };
    vec2.copy(_ray.from, this.position);
    vec2.copy(_ray.to, _end);
    _ray.collisionGroup = this.getCollisionGroup();
    _ray.collisionMask = this.getCollisionMask();
    _ray.update();
    this.world!.raycast(_result, _ray);

    if (!hit) {
      return false;
    }

    const rememberAngle = this.angle;
    vec2.copy(_rememberPosition, this.position);

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
      vec2.scale(_integrateVelodt, _startToEnd, timeOfImpact);
      vec2.add(this.position, _rememberPosition, _integrateVelodt);
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

    vec2.copy(this.position, _rememberPosition);
    this.angle = rememberAngle;

    // move to TOI
    vec2.scale(_integrateVelodt, _startToEnd, timeOfImpact);
    vec2.add(this.position, this.position, _integrateVelodt);
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
