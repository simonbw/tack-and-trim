import { CompatibleVector, V, V2d } from "../../Vector";
import {
  SOLVER_ADD_VELOCITY,
  SOLVER_INV_INERTIA,
  SOLVER_INV_MASS,
  SOLVER_UPDATE_MASS,
  SOLVER_VLAMBDA,
  SOLVER_WLAMBDA,
} from "../internal";
import Body, { BaseBodyOptions, SleepState } from "./Body";
import { integrateToTimeOfImpact } from "./ccdUtils";
import { SleepBehavior, type SleepableBody } from "./SleepBehavior";

/** Options for creating a DynamicBody. */
export interface DynamicBodyOptions extends BaseBodyOptions {
  /** Total mass of the body. Required. */
  mass: number;
  /** Initial linear velocity. */
  velocity?: CompatibleVector;
  /** Initial angular velocity in radians/second. */
  angularVelocity?: number;
  /** Linear velocity damping (0-1). Default 0.1. */
  damping?: number;
  /** Angular velocity damping (0-1). Default 0.1. */
  angularDamping?: number;
  /** If true, body cannot rotate. */
  fixedRotation?: boolean;
  /** If true, body cannot move on X axis. */
  fixedX?: boolean;
  /** If true, body cannot move on Y axis. */
  fixedY?: boolean;
  /** Whether this body can sleep when idle. Default true. */
  allowSleep?: boolean;
  /** Speed below which body becomes sleepy. Default 0.2. */
  sleepSpeedLimit?: number;
  /** Seconds of low speed before sleeping. Default 1. */
  sleepTimeLimit?: number;
  /** Enable CCD above this speed (-1 to disable). Default -1. */
  ccdSpeedThreshold?: number;
  /** Binary search iterations for CCD. Default 10. */
  ccdIterations?: number;
}

/**
 * A body that responds to forces and collisions.
 * This is the most common body type for game objects like players, projectiles, and physics props.
 */
export default class DynamicBody extends Body implements SleepableBody {
  private _velocity: V2d = V();
  private _angularVelocity: number = 0;
  private _angularForce: number = 0;

  private _mass: number;
  private _invMass: number = 0;
  private _inertia: number = 0;
  private _invInertia: number = 0;
  private _invMassSolve: number = 0;
  private _invInertiaSolve: number = 0;

  /** If true, body cannot rotate. */
  fixedRotation: boolean;
  /** If true, body cannot move on X axis. */
  fixedX: boolean;
  /** If true, body cannot move on Y axis. */
  fixedY: boolean;
  /** @internal */
  massMultiplier: V2d = V();

  /** Linear velocity damping per second (0 = no damping, 1 = full stop). */
  damping: number;
  /** Angular velocity damping per second. */
  angularDamping: number;

  /** Sleep behavior manager. */
  private _sleep: SleepBehavior;

  /** Speed threshold for enabling CCD. -1 disables CCD. */
  ccdSpeedThreshold: number;
  /** Number of binary search iterations for CCD. */
  ccdIterations: number;

  constructor(options: DynamicBodyOptions) {
    super(options);

    this._mass = options.mass;

    if (options.velocity) {
      this._velocity.set(options.velocity);
    }
    this._angularVelocity = options.angularVelocity || 0;

    this.fixedRotation = options.fixedRotation ?? false;
    this.fixedX = options.fixedX ?? false;
    this.fixedY = options.fixedY ?? false;

    this.damping = options.damping ?? 0.1;
    this.angularDamping = options.angularDamping ?? 0.1;

    this._sleep = new SleepBehavior({
      allowSleep: options.allowSleep ?? true,
      sleepSpeedLimit: options.sleepSpeedLimit ?? 0.2,
      sleepTimeLimit: options.sleepTimeLimit ?? 1,
    });

    this.ccdSpeedThreshold = options.ccdSpeedThreshold ?? -1;
    this.ccdIterations = options.ccdIterations ?? 10;

    this.updateMassProperties();
  }

  // Getters/setters for abstract properties
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
    return this._angularForce;
  }
  set angularForce(value: number) {
    this._angularForce = value;
  }

  get mass(): number {
    return this._mass;
  }
  set mass(value: number) {
    this._mass = value;
    this.updateMassProperties();
  }

  get invMass(): number {
    return this._invMass;
  }

  get inertia(): number {
    return this._inertia;
  }

  get invInertia(): number {
    return this._invInertia;
  }

  // Solver-internal getters (hidden from autocomplete via symbols)
  get [SOLVER_INV_MASS](): number {
    return this._invMassSolve;
  }

  get [SOLVER_INV_INERTIA](): number {
    return this._invInertiaSolve;
  }

  /** Current sleep state. */
  get sleepState(): SleepState {
    return this._sleep.sleepState;
  }

  /** Whether this body is allowed to sleep. */
  get allowSleep(): boolean {
    return this._sleep.allowSleep;
  }

  /** Speed threshold below which body becomes sleepy. */
  get sleepSpeedLimit(): number {
    return this._sleep.sleepSpeedLimit;
  }

  /** @internal True if body is ready to sleep (used for island sleeping). */
  get wantsToSleep(): boolean {
    return this._sleep.wantsToSleep;
  }

  /** Time spent below sleep speed limit. */
  get idleTime(): number {
    return this._sleep.idleTime;
  }
  set idleTime(value: number) {
    this._sleep.idleTime = value;
  }

  /** @internal */
  get timeLastSleepy(): number {
    return this._sleep.timeLastSleepy;
  }
  set timeLastSleepy(value: number) {
    this._sleep.timeLastSleepy = value;
  }

  /** Returns true if the body is currently sleeping. */
  isSleeping(): boolean {
    return this._sleep.isSleeping();
  }

  /** Returns true if the body is currently awake. */
  isAwake(): boolean {
    return this._sleep.isAwake();
  }

  /**
   * Updates .inertia, .invMass, .invInertia for this Body.
   * Called automatically when setting mass or density, or adding/removing shapes.
   * You should only need to call this yourself when modifying shapes.
   */
  updateMassProperties(): this {
    const shapes = this.shapes;
    const N = shapes.length;
    const m = this._mass / (N || 1);
    let I = 0;

    if (!this.fixedRotation) {
      for (let i = 0; i < N; i++) {
        const shape = shapes[i];
        const r2 = shape.position.squaredMagnitude;
        const Icm = shape.computeMomentOfInertia(m);
        I += Icm + m * r2;
      }
      this._inertia = I;
      this._invInertia = I > 0 ? 1 / I : 0;
    } else {
      this._inertia = Number.MAX_VALUE;
      this._invInertia = 0;
    }

    this._invMass = 1 / this._mass;
    this.massMultiplier.set(this.fixedX ? 0 : 1, this.fixedY ? 0 : 1);
    return this;
  }

  /**
   * Update solver mass properties based on sleep state. (Solver internal)
   */
  [SOLVER_UPDATE_MASS](): void {
    if (this.isSleeping()) {
      this._invMassSolve = 0;
      this._invInertiaSolve = 0;
    } else {
      this._invMassSolve = this._invMass;
      this._invInertiaSolve = this._invInertia;
    }
  }

  /**
   * Density of the body derived from mass and total area.
   */
  get density(): number {
    const totalArea = this.getArea();
    return totalArea > 0 ? this._mass / totalArea : 0;
  }
  set density(density: number) {
    const totalArea = this.getArea();
    this._mass = totalArea * density;
    this.updateMassProperties();
  }

  /**
   * Apply force to a point relative to the center of mass of the body.
   */
  applyForce(force: V2d, relativePoint?: V2d): this {
    this._force.iadd(force);

    if (relativePoint) {
      const rotForce = relativePoint.crossLength(force);
      this._angularForce += rotForce;
    }
    return this;
  }

  /**
   * Apply force to a body-local point.
   */
  applyForceLocal(localForce: V2d, localPoint?: V2d): this {
    const worldForce = this.vectorToWorldFrame(localForce);
    const worldPoint = localPoint
      ? this.vectorToWorldFrame(localPoint)
      : undefined;
    this.applyForce(worldForce, worldPoint);
    return this;
  }

  /**
   * Apply impulse to a point relative to the body.
   */
  applyImpulse(impulseVector: V2d, relativePoint?: V2d): this {
    const velo = V(impulseVector);
    velo.imul(this._invMass);
    velo.imulComponent(this.massMultiplier);
    this._velocity.iadd(velo);

    if (relativePoint) {
      let rotVelo = relativePoint.crossLength(impulseVector);
      rotVelo *= this._invInertia;
      this._angularVelocity += rotVelo;
    }
    return this;
  }

  /**
   * Apply impulse to a body-local point.
   */
  applyImpulseLocal(localImpulse: V2d, localPoint?: V2d): this {
    const worldImpulse = this.vectorToWorldFrame(localImpulse);
    const worldPoint = localPoint
      ? this.vectorToWorldFrame(localPoint)
      : undefined;
    this.applyImpulse(worldImpulse, worldPoint);
    return this;
  }

  /**
   * Apply damping to velocity.
   */
  applyDamping(dt: number): void {
    const v = this._velocity;
    v.imul(Math.pow(1.0 - this.damping, dt));
    this._angularVelocity *= Math.pow(1.0 - this.angularDamping, dt);
  }

  /**
   * Sets the force on the body to zero.
   */
  setZeroForce(): this {
    this._force.set(0.0, 0.0);
    this._angularForce = 0.0;
    return this;
  }

  [SOLVER_ADD_VELOCITY](): void {
    this._velocity.iadd(this[SOLVER_VLAMBDA]);
    this._angularVelocity += this[SOLVER_WLAMBDA];
  }

  /**
   * Wake the body up.
   */
  wakeUp(): this {
    this._sleep.wakeUp(this);
    return this;
  }

  /**
   * Force body sleep
   */
  sleep(): this {
    this._sleep.sleep(this);
    return this;
  }

  /**
   * Called every timestep to update internal sleep timer and change sleep state if needed.
   */
  sleepTick(time: number, dontSleep: boolean, dt: number): void {
    this._sleep.sleepTick(this, time, dontSleep, dt);
  }

  /**
   * Moves the shape offsets so their center of mass becomes the body center of mass.
   */
  adjustCenterOfMass(): this {
    const sum = V();
    let totalArea = 0;

    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      const offset_times_area = V(s.position);
      offset_times_area.imul(s.area);
      sum.iadd(offset_times_area);
      totalArea += s.area;
    }

    const cm = V(sum);
    cm.imul(1 / totalArea);

    // Now move all shapes
    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      s.position.isub(cm);
    }

    // Move the body position too
    this.position.iadd(cm);

    // And concave path
    for (let i = 0; this.concavePath && i < this.concavePath.length; i++) {
      this.concavePath[i].isub(cm);
    }

    this.updateMassProperties();
    this.updateBoundingRadius();
    return this;
  }

  /**
   * Move the body forward in time given its current velocity.
   */
  integrate(dt: number): void {
    const minv = this._invMass;
    const f = this._force;
    const pos = this.position;
    const velo = this._velocity;

    // Velocity update
    if (!this.fixedRotation) {
      this._angularVelocity += this._angularForce * this._invInertia * dt;
    }
    const fhMinv = V(f);
    fhMinv.imul(dt * minv);
    fhMinv.imulComponent(this.massMultiplier);
    velo.iadd(fhMinv);

    // CCD - use utility function
    const ccdApplied =
      this.world &&
      integrateToTimeOfImpact(
        this,
        this,
        {
          ccdSpeedThreshold: this.ccdSpeedThreshold,
          ccdIterations: this.ccdIterations,
        },
        this.world,
        dt
      );

    if (!ccdApplied) {
      // Regular position update
      const velodt = V(velo);
      velodt.imul(dt);
      pos.iadd(velodt);
      if (!this.fixedRotation) {
        this.angle += this._angularVelocity * dt;
      }
    }

    this.aabbNeedsUpdate = true;
  }
}
