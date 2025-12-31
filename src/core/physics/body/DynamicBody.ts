import { CompatibleVector, V, V2d } from "../../Vector";
import Body, { BaseBodyOptions } from "./Body";

export interface DynamicBodyOptions extends BaseBodyOptions {
  mass: number; // Required for dynamic bodies
  velocity?: CompatibleVector;
  angularVelocity?: number;
  damping?: number;
  angularDamping?: number;
  fixedRotation?: boolean;
  fixedX?: boolean;
  fixedY?: boolean;
  allowSleep?: boolean;
  sleepSpeedLimit?: number;
  sleepTimeLimit?: number;
  ccdSpeedThreshold?: number;
  ccdIterations?: number;
}

/**
 * A dynamic body that responds to forces, has mass, and can sleep.
 * This is the most common body type for game objects.
 */
export default class DynamicBody extends Body {
  // Velocity state
  private _velocity: V2d = V();
  private _angularVelocity: number = 0;

  // Angular force accumulation (linear force is in base class)
  private _angularForce: number = 0;

  // Mass properties
  private _mass: number;
  private _invMass: number = 0;
  private _inertia: number = 0;
  private _invInertia: number = 0;
  private _invMassSolve: number = 0;
  private _invInertiaSolve: number = 0;

  // Mass modification
  fixedRotation: boolean;
  fixedX: boolean;
  fixedY: boolean;
  massMultiplier: V2d = V();

  // Damping
  damping: number;
  angularDamping: number;

  // Sleep state
  private _sleepState: number;
  private _allowSleep: boolean;
  private _sleepSpeedLimit: number;
  private _sleepTimeLimit: number;
  private _wantsToSleep: boolean = false;
  idleTime: number = 0;
  timeLastSleepy: number = 0;

  // CCD
  ccdSpeedThreshold: number;
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

    this._allowSleep = options.allowSleep ?? true;
    this._sleepState = Body.AWAKE;
    this._sleepSpeedLimit = options.sleepSpeedLimit ?? 0.2;
    this._sleepTimeLimit = options.sleepTimeLimit ?? 1;

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

  get invMassSolve(): number {
    return this._invMassSolve;
  }

  get invInertiaSolve(): number {
    return this._invInertiaSolve;
  }

  get sleepState(): number {
    return this._sleepState;
  }

  get allowSleep(): boolean {
    return this._allowSleep;
  }

  get sleepSpeedLimit(): number {
    return this._sleepSpeedLimit;
  }

  get wantsToSleep(): boolean {
    return this._wantsToSleep;
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
   * Update solver mass properties based on sleep state.
   */
  updateSolveMassProperties(): void {
    if (this._sleepState === Body.SLEEPING) {
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

  addConstraintVelocity(): void {
    this._velocity.iadd(this._vlambda);
    this._angularVelocity += this._wlambda;
  }

  /**
   * Wake the body up.
   */
  wakeUp(): this {
    const s = this._sleepState;
    this._sleepState = Body.AWAKE;
    this.idleTime = 0;
    if (s !== Body.AWAKE) {
      this.emit({ type: "wakeup", body: this });
    }
    return this;
  }

  /**
   * Force body sleep
   */
  sleep(): this {
    this._sleepState = Body.SLEEPING;
    this._angularVelocity = 0;
    this._angularForce = 0;
    this._velocity.set(0, 0);
    this._force.set(0, 0);
    this.emit({ type: "sleep", body: this });
    return this;
  }

  /**
   * Called every timestep to update internal sleep timer and change sleep state if needed.
   */
  sleepTick(time: number, dontSleep: boolean, dt: number): void {
    if (!this._allowSleep || this._sleepState === Body.SLEEPING) {
      return;
    }

    this._wantsToSleep = false;

    const speedSquared =
      this._velocity.squaredMagnitude + Math.pow(this._angularVelocity, 2);
    const speedLimitSquared = Math.pow(this._sleepSpeedLimit, 2);

    if (speedSquared >= speedLimitSquared) {
      this.idleTime = 0;
      this._sleepState = Body.AWAKE;
    } else {
      this.idleTime += dt;
      this._sleepState = Body.SLEEPY;
    }
    if (this.idleTime > this._sleepTimeLimit) {
      if (!dontSleep) {
        this.sleep();
      } else {
        this._wantsToSleep = true;
      }
    }
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

    // Save old position
    this.previousPosition.set(this.position);
    this.previousAngle = this.angle;

    // Velocity update
    if (!this.fixedRotation) {
      this._angularVelocity += this._angularForce * this._invInertia * dt;
    }
    const fhMinv = V(f);
    fhMinv.imul(dt * minv);
    fhMinv.imulComponent(this.massMultiplier);
    velo.iadd(fhMinv);

    // CCD
    if (!this.integrateToTimeOfImpact(dt)) {
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

  /**
   * Continuous collision detection integration.
   */
  private integrateToTimeOfImpact(dt: number): boolean {
    if (
      this.ccdSpeedThreshold < 0 ||
      this._velocity.squaredMagnitude < Math.pow(this.ccdSpeedThreshold, 2)
    ) {
      return false;
    }

    const direction = V(this._velocity);
    direction.inormalize();

    const end = V(this._velocity);
    end.imul(dt);
    end.iadd(this.position);

    const startToEnd = V(end);
    startToEnd.isub(this.position);
    const startToEndAngle = this._angularVelocity * dt;
    const len = startToEnd.magnitude;

    let timeOfImpact = 1;

    // Use new raycast API with filter to exclude self
    const that = this;
    const raycastHit = this.world!.raycast(this.position, end, {
      filter: (body) => body !== that,
    });

    if (!raycastHit) {
      return false;
    }

    // Update end point and time of impact based on hit
    end.set(raycastHit.point);
    startToEnd.set(end).isub(this.position);
    timeOfImpact = startToEnd.magnitude / len;

    const hitBody: Body = raycastHit.body;

    const rememberAngle = this.angle;
    const rememberPosition = V(this.position);

    // Binary search for time of impact
    let iter = 0;
    let tmin = 0;
    let tmid = 0;
    let tmax = timeOfImpact;
    while (tmax >= tmin && iter < this.ccdIterations) {
      iter++;

      tmid = (tmax - tmin) / 2;

      const velodt = V(startToEnd);
      velodt.imul(timeOfImpact);
      this.position.set(rememberPosition).iadd(velodt);
      this.angle = rememberAngle + startToEndAngle * timeOfImpact;
      this.updateAABB();

      const overlaps =
        this.aabb.overlaps(hitBody.aabb) &&
        this.world!.narrowphase.bodiesOverlap(this, hitBody);

      if (overlaps) {
        tmin = tmid;
      } else {
        tmax = tmid;
      }
    }

    timeOfImpact = tmid;

    this.position.set(rememberPosition);
    this.angle = rememberAngle;

    // Move to TOI
    const velodt = V(startToEnd);
    velodt.imul(timeOfImpact);
    this.position.iadd(velodt);
    if (!this.fixedRotation) {
      this.angle += startToEndAngle * timeOfImpact;
    }

    return true;
  }
}
