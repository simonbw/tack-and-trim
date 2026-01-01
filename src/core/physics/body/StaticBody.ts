import { V, V2d } from "../../Vector";
import Body, { BaseBodyOptions, SleepState } from "./Body";

export interface StaticBodyOptions extends BaseBodyOptions {
  // Static bodies don't need mass, velocity, etc.
}

// Immutable zero vector for static body velocity
const ZERO_VELOCITY = Object.freeze(V(0, 0)) as V2d;

/**
 * A static body that never moves and has infinite mass.
 * Use for ground, walls, and other immovable objects.
 */
export default class StaticBody extends Body {
  constructor(options: StaticBodyOptions = {}) {
    super(options);
  }

  // Immutable velocity (always zero)
  get velocity(): V2d {
    return ZERO_VELOCITY;
  }

  get angularVelocity(): number {
    return 0;
  }
  set angularVelocity(_value: number) {
    // No-op - static bodies don't rotate
  }

  get angularForce(): number {
    return 0;
  }
  set angularForce(_value: number) {
    // No-op
  }

  // Mass properties (infinite mass, zero inverse)
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

  // Sleep state (always awake - never sleeps)
  get sleepState(): SleepState {
    return SleepState.AWAKE;
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
    // No-op for static bodies
    return this;
  }

  updateSolveMassProperties(): void {
    // No-op - invMassSolve is always 0
  }

  applyForce(_force: V2d, _relativePoint?: V2d): this {
    // No-op - static bodies don't respond to forces
    return this;
  }

  applyForceLocal(_localForce: V2d, _localPoint?: V2d): this {
    // No-op
    return this;
  }

  applyImpulse(_impulseVector: V2d, _relativePoint?: V2d): this {
    // No-op - static bodies don't respond to impulses
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
    // No-op - static bodies don't get velocity updates from constraints
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

  integrate(_dt: number): void {
    // Static bodies don't move, but we still need to track previous position for interpolation
    this.previousPosition.set(this.position);
    this.previousAngle = this.angle;
  }
}
