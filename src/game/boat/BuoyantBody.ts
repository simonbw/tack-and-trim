import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { V } from "../../core/Vector";
import { clamp } from "../../core/util/MathUtil";

export interface BuoyantBodyOptions {
  body: DynamicBody;
  verticalMass: number;
  rollInertia: number;
  pitchInertia: number;
  maxRoll: number;
  maxPitch: number;
}

/**
 * Wraps a 2D DynamicBody with 3 additional vertical degrees of freedom:
 * z (vertical position), roll, and pitch.
 *
 * The 2D physics engine continues to handle (x, y, yaw) via the inner body.
 * This class integrates the vertical DOFs separately, driven by 3D forces
 * applied through `applyForce3D`.
 *
 * All force application goes through a unified 3D API — forces applied at
 * body-local 3D points naturally produce both 2D forces (on the inner body)
 * and vertical torques (on the roll/pitch/z state).
 */
export class BuoyantBody {
  readonly body: DynamicBody;

  // Vertical position and orientation state
  z: number = 0;
  roll: number = 0; // positive = heel toward port (+y)
  pitch: number = 0; // positive = bow up

  // Vertical velocities
  zVelocity: number = 0;
  rollVelocity: number = 0;
  pitchVelocity: number = 0;

  // Mass properties for vertical DOFs
  verticalMass: number;
  rollInertia: number;
  pitchInertia: number;

  // Safety clamps
  maxRoll: number;
  maxPitch: number;

  // Force/torque accumulators (reset each tick)
  private zForce: number = 0;
  private rollTorque: number = 0;
  private pitchTorque: number = 0;

  // Reusable vector for 2D force application
  private readonly _relPoint = V();

  constructor(options: BuoyantBodyOptions) {
    this.body = options.body;
    this.verticalMass = options.verticalMass;
    this.rollInertia = options.rollInertia;
    this.pitchInertia = options.pitchInertia;
    this.maxRoll = options.maxRoll;
    this.maxPitch = options.maxPitch;
  }

  /**
   * Apply a 3D force at a body-local 3D point.
   *
   * This is the primary force API. It:
   * 1. Applies the 2D component (fx, fy) to the inner DynamicBody with the
   *    body-local XY offset as the relative point (producing 2D force + yaw torque)
   * 2. Computes roll and pitch torques from the 3D cross product of the
   *    application point × force in the body-local frame
   * 3. Accumulates fz as vertical force
   *
   * @param fx - World-frame force X component
   * @param fy - World-frame force Y component
   * @param fz - World-frame force Z component (up = positive)
   * @param localX - Body-local application point X (forward)
   * @param localY - Body-local application point Y (port)
   * @param localZ - Body-local application point Z (up from waterline)
   */
  applyForce3D(
    fx: number,
    fy: number,
    fz: number,
    localX: number,
    localY: number,
    localZ: number,
  ): void {
    // 1. Apply 2D force to inner body
    // The relative point needs to be in world frame (rotated by body angle)
    this._relPoint.set(localX, localY);
    const worldRelPoint = this.body.vectorToWorldFrame(this._relPoint);
    this._relPoint.set(fx, fy);
    this.body.applyForce(this._relPoint, worldRelPoint);

    // 2. Compute vertical torques
    // Transform world force to body-local frame for cross product
    const cos = Math.cos(this.body.angle);
    const sin = Math.sin(this.body.angle);
    const fxLocal = fx * cos + fy * sin;
    const fyLocal = -fx * sin + fy * cos;

    // Cross product r × F in body-local frame:
    //   torque = (localY * fz - localZ * fyLocal,   // roll axis (around forward)
    //             localZ * fxLocal - localX * fz,    // pitch axis (around lateral)
    //             localX * fyLocal - localY * fxLocal) // yaw (handled by 2D body)
    // Roll torque: lateral force at height, or vertical force off-center laterally
    this.rollTorque += fyLocal * localZ - fz * localY;
    // Pitch torque: vertical force off-center fore/aft, or forward force at height
    this.pitchTorque += fz * localX - fxLocal * localZ;

    // 3. Accumulate vertical force
    this.zForce += fz;
  }

  /**
   * Apply only vertical torques from a 3D force, without touching the 2D body.
   *
   * Use this for forces that already flow through the 2D constraint system
   * (e.g. sail reaction forces applied through mast/boom constraints).
   * This prevents double-applying the 2D component while still getting
   * the correct roll/pitch torques from the force's z-height.
   *
   * @param fx - World-frame force X component
   * @param fy - World-frame force Y component
   * @param fz - World-frame force Z component (up = positive)
   * @param localX - Body-local application point X (forward)
   * @param localY - Body-local application point Y (port)
   * @param localZ - Body-local application point Z (up from waterline)
   */
  applyVerticalTorqueFrom(
    fx: number,
    fy: number,
    fz: number,
    localX: number,
    localY: number,
    localZ: number,
  ): void {
    // Transform world force to body-local frame
    const cos = Math.cos(this.body.angle);
    const sin = Math.sin(this.body.angle);
    const fxLocal = fx * cos + fy * sin;
    const fyLocal = -fx * sin + fy * cos;

    this.rollTorque += fyLocal * localZ - fz * localY;
    this.pitchTorque += fz * localX - fxLocal * localZ;
    this.zForce += fz;
  }

  /**
   * Integrate the vertical DOFs using semi-implicit Euler.
   * Call this once per tick, after the 2D physics world step.
   */
  integrateVertical(dt: number): void {
    // Semi-implicit Euler: update velocity first, then position
    this.zVelocity += (this.zForce / this.verticalMass) * dt;
    this.rollVelocity += (this.rollTorque / this.rollInertia) * dt;
    this.pitchVelocity += (this.pitchTorque / this.pitchInertia) * dt;

    this.z += this.zVelocity * dt;
    this.roll += this.rollVelocity * dt;
    this.pitch += this.pitchVelocity * dt;

    // Safety clamps
    this.roll = clamp(this.roll, -this.maxRoll, this.maxRoll);
    this.pitch = clamp(this.pitch, -this.maxPitch, this.maxPitch);
  }

  /**
   * Directly inject roll and pitch torques without computing from forces.
   * Use for legacy code that computes torques directly rather than through
   * 3D force application.
   */
  applyTorque(rollTorque: number, pitchTorque: number): void {
    this.rollTorque += rollTorque;
    this.pitchTorque += pitchTorque;
  }

  /**
   * Reset vertical force/torque accumulators. Call after integrateVertical.
   */
  resetVerticalForces(): void {
    this.zForce = 0;
    this.rollTorque = 0;
    this.pitchTorque = 0;
  }
}
