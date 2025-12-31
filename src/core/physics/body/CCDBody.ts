import { V } from "../../Vector";
import Ray from "../collision/Ray";
import RaycastResult from "../collision/RaycastResult";
import Body from "./Body";

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

    const end = V(this.velocity).imul(dt).iadd(this.position);
    const startToEnd = V(end).isub(this.position);
    const startToEndAngle = this.angularVelocity * dt;
    const len = startToEnd.magnitude;

    let timeOfImpact = 1;
    let hit: Body | undefined;
    const self = this;

    const result = new RaycastResult();
    const ray = new Ray({
      from: this.position,
      to: end,
      mode: Ray.CLOSEST,
      skipBackfaces: true,
    });

    ray.callback = function (rayResult: RaycastResult) {
      if (rayResult.body === self) {
        return;
      }
      hit = rayResult.body ?? undefined;
      end.set(rayResult.getHitPoint(ray));
      startToEnd.set(end).isub(self.position);
      timeOfImpact = startToEnd.magnitude / len;
      rayResult.stop();
    };

    ray.collisionGroup = this.getCollisionGroup();
    ray.collisionMask = this.getCollisionMask();
    ray.update();
    this.world!.raycast(result, ray);

    if (!hit) {
      return false;
    }

    const rememberAngle = this.angle;
    const rememberPosition = V(this.position);

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
      const integrateVelodt = V(startToEnd).imul(timeOfImpact);
      this.position.set(rememberPosition).iadd(integrateVelodt);
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

    this.position.set(rememberPosition);
    this.angle = rememberAngle;

    // move to TOI
    const finalVelodt = V(startToEnd).imul(timeOfImpact);
    this.position.iadd(finalVelodt);
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
