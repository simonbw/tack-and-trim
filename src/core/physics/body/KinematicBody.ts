import { CompatibleVector, V, V2d } from "../../Vector";
import Body, { BaseBodyOptions } from "./Body";

export interface KinematicBodyOptions extends BaseBodyOptions {
  velocity?: CompatibleVector;
  angularVelocity?: number;
}

/**
 * A kinematic body that can be moved programmatically but doesn't respond to forces.
 * Use for moving platforms, elevators, and other scripted moving objects.
 */
export default class KinematicBody extends Body {
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

  get invMassSolve(): number {
    return 0;
  }

  get invInertiaSolve(): number {
    return 0;
  }

  // Sleep state (kinematic bodies don't sleep)
  get sleepState(): number {
    return Body.AWAKE;
  }

  get allowSleep(): boolean {
    return false;
  }

  get sleepSpeedLimit(): number {
    return 0;
  }

  get wantsToSleep(): boolean {
    return false;
  }

  updateMassProperties(): this {
    // No-op for kinematic bodies
    return this;
  }

  updateSolveMassProperties(): void {
    // Always 0 for kinematic - they push but aren't pushed
  }

  applyForce(_force: V2d, _relativePoint?: V2d): this {
    // No-op - kinematic bodies don't respond to forces
    return this;
  }

  applyForceLocal(_localForce: V2d, _localPoint?: V2d): this {
    // No-op
    return this;
  }

  applyImpulse(_impulseVector: V2d, _relativePoint?: V2d): this {
    // No-op - kinematic bodies don't respond to impulses
    return this;
  }

  applyImpulseLocal(_localImpulse: V2d, _localPoint?: V2d): this {
    // No-op
    return this;
  }

  applyDamping(_dt: number): void {
    // No-op
  }

  setZeroForce(): this {
    this._force.set(0, 0);
    return this;
  }

  addConstraintVelocity(): void {
    // No-op - kinematic bodies don't receive constraint velocity
  }

  wakeUp(): this {
    // No-op
    return this;
  }

  sleep(): this {
    // No-op
    return this;
  }

  sleepTick(_time: number, _dontSleep: boolean, _dt: number): void {
    // No-op
  }

  integrate(dt: number): void {
    // Save old position for interpolation
    this.previousPosition.set(this.position);
    this.previousAngle = this.angle;

    // Move according to velocity (set by game code)
    const velodt = V(this._velocity);
    velodt.imul(dt);
    this.position.iadd(velodt);
    this.angle += this._angularVelocity * dt;

    this.aabbNeedsUpdate = true;
  }
}
