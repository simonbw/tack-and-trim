import { CompatibleVector, V, V2d } from "../../Vector";
import { BaseBodyOptions, Body } from "./Body";

/** Options for creating a KinematicBody. */
export interface KinematicBodyOptions extends BaseBodyOptions {
  /** Initial linear velocity. */
  velocity?: CompatibleVector;
  /** Initial angular velocity in radians/second. */
  angularVelocity?: number;
}

/**
 * A kinematic body that can be moved programmatically but doesn't respond to forces.
 * Use for moving platforms, elevators, and other scripted moving objects.
 */
export class KinematicBody extends Body {
  // Velocity (can be set programmatically)
  private _velocity: V2d;
  private _angularVelocity: number;

  constructor(options: KinematicBodyOptions = {}) {
    super(options);

    this._velocity = V();
    if (options.velocity) {
      this._velocity.set(options.velocity);
    }
    this._angularVelocity = options.angularVelocity || 0;
  }

  get velocity(): V2d {
    return this._velocity;
  }

  get angularVelocity(): number {
    return this._angularVelocity;
  }
  set angularVelocity(value: number) {
    this._angularVelocity = value;
  }

  get angularForce(): number {
    return 0;
  }
  set angularForce(_value: number) {
    // No-op
  }

  // Mass properties (infinite mass, zero inverse - not affected by forces)
  get mass(): number {
    return Number.MAX_VALUE;
  }

  get invMass(): number {
    return 0;
  }

  get invInertia(): number {
    return 0;
  }

  updateMassProperties(): this {
    // No-op for kinematic bodies
    return this;
  }

  integrate(dt: number): void {
    // Move according to velocity (set by game code)
    const velodt = V(this._velocity);
    velodt.imul(dt);
    this.position.iadd(velodt);
    this.angle += this._angularVelocity * dt;

    this.aabbNeedsUpdate = true;
  }
}
