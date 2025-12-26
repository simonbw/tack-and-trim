import BaseEntity from "../core/entity/BaseEntity";
import { V, V2d } from "../core/Vector";

export class Wind extends BaseEntity {
  id = "wind";
  private velocity: V2d = V(100, 100);

  getVelocity(): V2d {
    return V(this.velocity);
  }

  getVelocityAtPoint(_point: [number, number]): V2d {
    // For now, constant wind everywhere
    // Later: could add spatial variation, gusts, etc.
    return this.getVelocity();
  }

  setVelocity(velocity: V2d): void {
    this.velocity.set(velocity);
  }

  setFromAngleAndSpeed(angle: number, speed: number): void {
    this.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  getSpeed(): number {
    return this.velocity.magnitude;
  }

  getAngle(): number {
    return this.velocity.angle;
  }
}
