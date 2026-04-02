import { CompatibleVector, V, V2d } from "../../Vector";
import { BaseBodyOptions, SleepState, Body } from "./Body";
import { integrateToTimeOfImpact } from "./ccdUtils";
import { SleepBehavior, type SleepableBody } from "./SleepBehavior";

/** Additional options for enabling 6DOF (z, roll, pitch) on a body. */
export interface SixDOFOptions {
  /** Moment of inertia for roll (rotation around forward/x axis). */
  rollInertia: number;
  /** Moment of inertia for pitch (rotation around lateral/y axis). */
  pitchInertia: number;
  /** Effective mass for z-axis motion (e.g. displaced water mass for buoyancy). */
  zMass?: number;
  /** Initial z position. Default 0. */
  zPosition?: number;
  /** Damping for z velocity (0-1). Default 0. */
  zDamping?: number;
  /** Damping for roll/pitch angular velocity (0-1). Default 0. */
  rollPitchDamping?: number;
  /** If true, body cannot move on Z axis. */
  fixedZ?: boolean;
}

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
  /** Enable 6DOF (z, roll, pitch) physics. */
  sixDOF?: SixDOFOptions;
}

/**
 * A body that responds to forces and collisions.
 * This is the most common body type for game objects like players, projectiles, and physics props.
 *
 * Optionally supports 6DOF (x, y, z, roll, pitch, yaw) when constructed with `sixDOF` options.
 * Orientation is stored as a 3x3 rotation matrix to support full rotation without gimbal lock.
 */
export class DynamicBody extends Body implements SleepableBody {
  private _velocity: V2d = V();

  private _mass: number;
  private _invMass: number = 0;
  private _inertia: number = 0;
  private _invInertia: number = 0;

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

  // ──────────────────────────────────────────────────────────────
  // 6DOF state
  // ──────────────────────────────────────────────────────────────

  /** Whether this body has 6DOF enabled. */
  private _is6DOF: boolean;

  /**
   * 3D angular velocity [wx, wy, wz] in world frame.
   * For 3DOF bodies, only [2] (yaw rate) is non-zero.
   * Always allocated so the solver can uniformly read/write it.
   */
  private _angularVelocity3 = new Float64Array(3);

  /**
   * 3D torque accumulator [tx, ty, tz] in world frame.
   * For 3DOF bodies, only [2] (yaw torque) is non-zero.
   */
  private _angularForce3 = new Float64Array(3);

  /**
   * 3x3 rotation matrix (row-major). Represents the body's full 3D orientation.
   * For 3DOF bodies, derived from `angle` (yaw-only rotation around Z).
   * For 6DOF bodies, this is the source of truth; `angle` is extracted from it.
   */
  private _orientation = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /**
   * World-frame 3x3 inverse inertia tensor (row-major, symmetric).
   * For 3DOF: only element [8] (yaw) is non-zero.
   * For 6DOF: recomputed each step from R * diag(1/Ix, 1/Iy, 1/Iz) * R^T.
   */
  private _invWorldInertia = new Float64Array(9);

  // 6DOF-only fields (meaningful only when _is6DOF is true)
  private _z: number = 0;
  private _zVelocity: number = 0;
  private _zForce: number = 0;
  private _invZMass: number = 0;
  private _zDamping: number = 0;
  private _rollPitchDamping: number = 0;
  private _fixedZ: boolean = false;

  // Inverse body-frame diagonal inertia for roll/pitch.
  // Yaw inertia uses the existing _inertia / _invInertia fields.
  private _invRollInertia: number = 0;
  private _invPitchInertia: number = 0;

  constructor(options: DynamicBodyOptions) {
    super(options);

    this._mass = options.mass;

    if (options.velocity) {
      this._velocity.set(options.velocity);
    }
    if (options.angularVelocity) {
      this._angularVelocity3[2] = options.angularVelocity;
    }

    this.fixedRotation = options.fixedRotation ?? false;
    this.fixedX = options.fixedX ?? false;
    this.fixedY = options.fixedY ?? false;

    this.damping = options.damping ?? 0;
    this.angularDamping = options.angularDamping ?? 0;

    this._sleep = new SleepBehavior({
      allowSleep: options.allowSleep ?? true,
      sleepSpeedLimit: options.sleepSpeedLimit ?? 0.2,
      sleepTimeLimit: options.sleepTimeLimit ?? 1,
    });

    this.ccdSpeedThreshold = options.ccdSpeedThreshold ?? -1;
    this.ccdIterations = options.ccdIterations ?? 10;

    // Initialize 6DOF state
    const s = options.sixDOF;
    this._is6DOF = !!s;
    if (s) {
      this._invRollInertia = s.rollInertia > 0 ? 1 / s.rollInertia : 0;
      this._invPitchInertia = s.pitchInertia > 0 ? 1 / s.pitchInertia : 0;
      this._z = s.zPosition ?? 0;
      const zMass = s.zMass ?? options.mass;
      this._invZMass = zMass > 0 ? 1 / zMass : 0;
      this._zDamping = s.zDamping ?? 0;
      this._rollPitchDamping = s.rollPitchDamping ?? 0;
      this._fixedZ = s.fixedZ ?? false;
    }

    // Initialize orientation from initial angle
    if (this.angle !== 0) {
      this._syncOrientationFromAngle();
    }

    this.updateMassProperties();
  }

  // ──────────────────────────────────────────────────────────────
  // Standard getters/setters (backward compatible)
  // ──────────────────────────────────────────────────────────────

  get velocity(): V2d {
    return this._velocity;
  }

  get angularVelocity(): number {
    return this._angularVelocity3[2];
  }
  set angularVelocity(value: number) {
    this._angularVelocity3[2] = value;
  }

  get angularForce(): number {
    return this._angularForce3[2];
  }
  set angularForce(value: number) {
    this._angularForce3[2] = value;
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

  // ──────────────────────────────────────────────────────────────
  // 6DOF accessors
  // ──────────────────────────────────────────────────────────────

  override get is6DOF(): boolean {
    return this._is6DOF;
  }

  override get z(): number {
    return this._z;
  }
  override set z(value: number) {
    this._z = value;
  }

  override get zVelocity(): number {
    return this._zVelocity;
  }
  override set zVelocity(value: number) {
    this._zVelocity = value;
  }

  override get zForce(): number {
    return this._zForce;
  }
  override set zForce(value: number) {
    this._zForce = value;
  }

  override get invMassZ(): number {
    return this._fixedZ ? 0 : this._invZMass;
  }

  /** 3D angular velocity [wx, wy, wz] in world frame. */
  override get angularVelocity3(): Float64Array {
    return this._angularVelocity3;
  }

  /** 3D torque accumulator [tx, ty, tz] in world frame. */
  override get angularForce3(): Float64Array {
    return this._angularForce3;
  }

  /** 3x3 rotation matrix (row-major). */
  override get orientation(): Float64Array {
    return this._orientation;
  }

  /** World-frame 3x3 inverse inertia tensor (row-major). */
  override get invWorldInertia(): Float64Array {
    return this._invWorldInertia;
  }

  /** Roll angle extracted from orientation matrix. */
  get roll(): number {
    const R = this._orientation;
    return Math.atan2(-R[7], R[8]); // atan2(-r21, r22)
  }

  /** Pitch angle extracted from orientation matrix. */
  get pitch(): number {
    const R = this._orientation;
    return Math.atan2(R[6], Math.sqrt(R[0] * R[0] + R[3] * R[3])); // atan2(r20, sqrt(r00²+r10²))
  }

  get rollVelocity(): number {
    // Body-local roll rate: project world angular velocity onto body forward axis
    const R = this._orientation;
    const w = this._angularVelocity3;
    return R[0] * w[0] + R[3] * w[1] + R[6] * w[2]; // dot(bodyForward, omega)
  }

  get pitchVelocity(): number {
    // Body-local pitch rate: project world angular velocity onto body lateral axis
    const R = this._orientation;
    const w = this._angularVelocity3;
    return R[1] * w[0] + R[4] * w[1] + R[7] * w[2]; // dot(bodyLateral, omega)
  }

  // ──────────────────────────────────────────────────────────────
  // Sleep
  // ──────────────────────────────────────────────────────────────

  get sleepState(): SleepState {
    return this._sleep.sleepState;
  }

  get allowSleep(): boolean {
    return this._sleep.allowSleep;
  }

  get sleepSpeedLimit(): number {
    return this._sleep.sleepSpeedLimit;
  }

  /** @internal True if body is ready to sleep (used for island sleeping). */
  get wantsToSleep(): boolean {
    return this._sleep.wantsToSleep;
  }

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

  isSleeping(): boolean {
    return this._sleep.isSleeping();
  }

  isAwake(): boolean {
    return this._sleep.isAwake();
  }

  // ──────────────────────────────────────────────────────────────
  // Mass properties
  // ──────────────────────────────────────────────────────────────

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

    // Update world inertia tensor for 3DOF bodies
    // (For 3DOF, yaw axis is always world-Z regardless of yaw angle)
    if (!this._is6DOF) {
      this._invWorldInertia.fill(0);
      this._invWorldInertia[8] = this._invInertia;
    }

    return this;
  }

  /**
   * Recompute the world-frame inverse inertia tensor from the orientation matrix.
   * Called once per physics step for 6DOF bodies (by World.applyForces).
   *
   * invI_world = R * diag(1/Ix, 1/Iy, 1/Iz) * R^T
   */
  recomputeWorldInertia(): void {
    const R = this._orientation;
    const iI = this._invWorldInertia;
    const invIx = this._invRollInertia;
    const invIy = this._invPitchInertia;
    const invIz = this._invInertia;

    // Compute symmetric 3x3: iI[i][j] = sum_k R[i*3+k] * invI_k * R[j*3+k]
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const val =
          R[i * 3] * invIx * R[j * 3] +
          R[i * 3 + 1] * invIy * R[j * 3 + 1] +
          R[i * 3 + 2] * invIz * R[j * 3 + 2];
        iI[i * 3 + j] = val;
        iI[j * 3 + i] = val;
      }
    }
  }

  get density(): number {
    const totalArea = this.getArea();
    return totalArea > 0 ? this._mass / totalArea : 0;
  }
  set density(density: number) {
    const totalArea = this.getArea();
    this._mass = totalArea * density;
    this.updateMassProperties();
  }

  // ──────────────────────────────────────────────────────────────
  // Force application
  // ──────────────────────────────────────────────────────────────

  /**
   * Apply force to a point relative to the center of mass of the body.
   * relativePoint is in world frame.
   */
  applyForce(force: V2d, relativePoint?: V2d): this {
    this._force.iadd(force);

    if (relativePoint) {
      const rotForce = relativePoint.crossLength(force);
      this._angularForce3[2] += rotForce;
    }
    return this;
  }

  /**
   * Apply a 3D force at a body-local 3D point.
   *
   * This is the unified force API for 6DOF bodies. It:
   * 1. Applies linear force (fx, fy) to the 2D force accumulator, fz to the z accumulator
   * 2. Computes the 3D cross product r × F in world frame for torque on all 3 rotation axes
   *
   * @param fx World-frame force X
   * @param fy World-frame force Y
   * @param fz World-frame force Z (up = positive)
   * @param localX Body-local application point X (forward)
   * @param localY Body-local application point Y (port)
   * @param localZ Body-local application point Z (up from reference)
   */
  applyForce3D(
    fx: number,
    fy: number,
    fz: number,
    localX: number,
    localY: number,
    localZ: number,
  ): this {
    // Linear force
    this._force.x += fx;
    this._force.y += fy;
    this._zForce += fz;

    // Transform application point from body-local to world-frame relative vector
    const R = this._orientation;
    const rx = R[0] * localX + R[1] * localY + R[2] * localZ;
    const ry = R[3] * localX + R[4] * localY + R[5] * localZ;
    const rz = R[6] * localX + R[7] * localY + R[8] * localZ;

    // Torque τ = r × F in world frame
    this._angularForce3[0] += ry * fz - rz * fy;
    this._angularForce3[1] += rz * fx - rx * fz;
    this._angularForce3[2] += rx * fy - ry * fx;

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
      this._angularVelocity3[2] += rotVelo;
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
    this._angularVelocity3[2] *= Math.pow(1.0 - this.angularDamping, dt);

    if (this._is6DOF) {
      this._zVelocity *= Math.pow(1.0 - this._zDamping, dt);
      const rpDamp = Math.pow(1.0 - this._rollPitchDamping, dt);
      this._angularVelocity3[0] *= rpDamp;
      this._angularVelocity3[1] *= rpDamp;
    }
  }

  /**
   * Sets the force on the body to zero.
   */
  setZeroForce(): this {
    this._force.set(0.0, 0.0);
    this._angularForce3[0] = 0;
    this._angularForce3[1] = 0;
    this._angularForce3[2] = 0;
    if (this._is6DOF) {
      this._zForce = 0;
    }
    return this;
  }

  // ──────────────────────────────────────────────────────────────
  // Sleep management
  // ──────────────────────────────────────────────────────────────

  wakeUp(): this {
    this._sleep.wakeUp(this);
    return this;
  }

  sleep(): this {
    this._sleep.sleep(this);
    return this;
  }

  sleepTick(time: number, dontSleep: boolean, dt: number): void {
    this._sleep.sleepTick(this, time, dontSleep, dt);
  }

  // ──────────────────────────────────────────────────────────────
  // Center of mass
  // ──────────────────────────────────────────────────────────────

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

    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      s.position.isub(cm);
    }

    this.position.iadd(cm);

    for (let i = 0; this.concavePath && i < this.concavePath.length; i++) {
      this.concavePath[i].isub(cm);
    }

    this.updateMassProperties();
    this.updateBoundingRadius();
    return this;
  }

  // ──────────────────────────────────────────────────────────────
  // Integration
  // ──────────────────────────────────────────────────────────────

  /**
   * Move the body forward in time given its current velocity.
   */
  integrate(dt: number): void {
    const minv = this._invMass;
    const f = this._force;
    const pos = this.position;
    const velo = this._velocity;

    // Linear velocity update (x, y)
    const fhMinv = V(f);
    fhMinv.imul(dt * minv);
    fhMinv.imulComponent(this.massMultiplier);
    velo.iadd(fhMinv);

    if (this._is6DOF) {
      // 6DOF: full angular velocity update via world-frame inertia tensor.
      // α = invI_world * τ (matrix-vector multiply for all 3 axes)
      const iI = this._invWorldInertia;
      const tf = this._angularForce3;
      this._angularVelocity3[0] +=
        (iI[0] * tf[0] + iI[1] * tf[1] + iI[2] * tf[2]) * dt;
      this._angularVelocity3[1] +=
        (iI[3] * tf[0] + iI[4] * tf[1] + iI[5] * tf[2]) * dt;
      this._angularVelocity3[2] +=
        (iI[6] * tf[0] + iI[7] * tf[1] + iI[8] * tf[2]) * dt;

      // Z velocity from force
      if (!this._fixedZ) {
        this._zVelocity += this._zForce * this._invZMass * dt;
      }
    } else {
      // 3DOF: scalar yaw torque only
      if (!this.fixedRotation) {
        this._angularVelocity3[2] +=
          this._angularForce3[2] * this._invInertia * dt;
      }
    }

    // CCD
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
        dt,
      );

    if (!ccdApplied) {
      // Position update (x, y)
      const velodt = V(velo);
      velodt.imul(dt);
      pos.iadd(velodt);

      if (this._is6DOF) {
        // Z position update
        this._z += this._zVelocity * dt;

        // Orientation update: R += skew(ω) * R * dt
        this._integrateOrientation(dt);
        // Extract yaw for backward compatibility
        this.angle = Math.atan2(this._orientation[3], this._orientation[0]);
      } else {
        // 3DOF: update angle directly, then sync orientation matrix
        if (!this.fixedRotation) {
          this.angle += this._angularVelocity3[2] * dt;
        }
        this._syncOrientationFromAngle();
      }
    }

    this.aabbNeedsUpdate = true;
  }

  // ──────────────────────────────────────────────────────────────
  // 3D transform helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Compute the world Z-height of a body-local 3D point.
   * Uses the third row of the rotation matrix: worldZ = R[6]*x + R[7]*y + R[8]*z + bodyZ
   */
  worldZ(localX: number, localY: number, localZ: number): number {
    const R = this._orientation;
    return R[6] * localX + R[7] * localY + R[8] * localZ + this._z;
  }

  /**
   * Transform a body-local 3D point to world coordinates [wx, wy, wz].
   * Uses the full rotation matrix plus body position and z offset.
   */
  toWorldFrame3D(
    localX: number,
    localY: number,
    localZ: number,
  ): [number, number, number] {
    const R = this._orientation;
    return [
      R[0] * localX + R[1] * localY + R[2] * localZ + this.position[0],
      R[3] * localX + R[4] * localY + R[5] * localZ + this.position[1],
      R[6] * localX + R[7] * localY + R[8] * localZ + this._z,
    ];
  }

  /**
   * Transform a world 3D point to body-local coordinates [lx, ly, lz].
   * Inverse of toWorldFrame3D — subtracts position/z, then applies transposed rotation.
   */
  toLocalFrame3D(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): [number, number, number] {
    const R = this._orientation;
    const dx = worldX - this.position[0];
    const dy = worldY - this.position[1];
    const dz = worldZ - this._z;
    // R is orthonormal, so R^-1 = R^T
    return [
      R[0] * dx + R[3] * dy + R[6] * dz,
      R[1] * dx + R[4] * dy + R[7] * dz,
      R[2] * dx + R[5] * dy + R[8] * dz,
    ];
  }

  /**
   * Get the world-space X parallax offset for a given z-height.
   * This is how much a point at height z shifts in screen X due to tilt.
   * Uses R[2] (the x-component of the rotation matrix's z-column).
   */
  zParallaxX(z: number): number {
    return this._orientation[2] * z;
  }

  /**
   * Get the world-space Y parallax offset for a given z-height.
   * Uses R[5] (the y-component of the rotation matrix's z-column).
   */
  zParallaxY(z: number): number {
    return this._orientation[5] * z;
  }

  // ──────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Update orientation matrix from yaw angle (for 3DOF bodies).
   */
  private _syncOrientationFromAngle(): void {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const R = this._orientation;
    R[0] = c;
    R[1] = -s;
    // R[2] = 0 (unchanged)
    R[3] = s;
    R[4] = c;
    // R[5] = 0 (unchanged)
    // R[6] = 0, R[7] = 0, R[8] = 1 (unchanged)
  }

  /**
   * Integrate the orientation matrix using angular velocity.
   * R_new = R + skew(ω) * R * dt, then re-orthogonalize.
   */
  private _integrateOrientation(dt: number): void {
    const R = this._orientation;
    const wx = this._angularVelocity3[0];
    const wy = this._angularVelocity3[1];
    const wz = this._angularVelocity3[2];

    // skew(ω) * R: each row of the result is ω × (row of R)
    // But since R is row-major, we compute column-by-column:
    // new_col_j = col_j + (ω × col_j) * dt
    for (let j = 0; j < 3; j++) {
      const c0 = R[j]; // column j, row 0
      const c1 = R[3 + j]; // column j, row 1
      const c2 = R[6 + j]; // column j, row 2

      // ω × c = (wy*c2 - wz*c1, wz*c0 - wx*c2, wx*c1 - wy*c0)
      R[j] += (wy * c2 - wz * c1) * dt;
      R[3 + j] += (wz * c0 - wx * c2) * dt;
      R[6 + j] += (wx * c1 - wy * c0) * dt;
    }

    // Re-orthogonalize using Gram-Schmidt on rows
    this._orthogonalizeOrientation();
  }

  /**
   * Gram-Schmidt re-orthogonalization of the rotation matrix rows.
   * Ensures the matrix stays a valid rotation matrix despite numerical drift.
   */
  private _orthogonalizeOrientation(): void {
    const R = this._orientation;

    // Row 0
    let len = Math.sqrt(R[0] * R[0] + R[1] * R[1] + R[2] * R[2]);
    if (len > 0) {
      R[0] /= len;
      R[1] /= len;
      R[2] /= len;
    }

    // Row 1: subtract projection onto row 0, then normalize
    let dot = R[3] * R[0] + R[4] * R[1] + R[5] * R[2];
    R[3] -= dot * R[0];
    R[4] -= dot * R[1];
    R[5] -= dot * R[2];
    len = Math.sqrt(R[3] * R[3] + R[4] * R[4] + R[5] * R[5]);
    if (len > 0) {
      R[3] /= len;
      R[4] /= len;
      R[5] /= len;
    }

    // Row 2: cross product of row 0 and row 1 (ensures right-handedness)
    R[6] = R[1] * R[5] - R[2] * R[4];
    R[7] = R[2] * R[3] - R[0] * R[5];
    R[8] = R[0] * R[4] - R[1] * R[3];
  }
}
