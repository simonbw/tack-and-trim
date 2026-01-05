import { CompatibleVector, V, V2d } from "../../Vector";
import AABB from "../collision/AABB";
import EventEmitter from "../events/EventEmitter";
import { PhysicsEventMap } from "../events/PhysicsEvents";
import {
  SOLVER_VLAMBDA,
  SOLVER_WLAMBDA,
  SOLVER_INV_MASS,
  SOLVER_INV_INERTIA,
  SOLVER_RESET_VELOCITY,
  SOLVER_ADD_VELOCITY,
  SOLVER_UPDATE_MASS,
} from "../internal";
import type Shape from "../shapes/Shape";
import type World from "../world/World";

export enum SleepState {
  AWAKE = 0,
  SLEEPY = 1,
  SLEEPING = 2,
}

export interface BaseBodyOptions {
  position?: CompatibleVector;
  angle?: number;
  id?: number;
  collisionResponse?: boolean;
}

/**
 * Abstract base class for physics bodies.
 * Subclasses: DynamicBody, StaticBody, KinematicBody
 */
export default abstract class Body extends EventEmitter<PhysicsEventMap> {
  static _idCounter = 0;

  // Identification
  readonly id: number;
  world: World | null = null;

  // Shape management
  shapes: Shape[] = [];
  concavePath: V2d[] | null = null;

  // Position and rotation
  position: V2d = V();
  angle: number = 0;

  // AABB for collision detection
  aabb: AABB = new AABB();
  aabbNeedsUpdate: boolean = true;
  boundingRadius: number = 0;

  // Collision settings
  collisionResponse: boolean;

  // Internal flag for narrowphase wake-up
  _wakeUpAfterNarrowphase: boolean = false;

  // Force accumulator
  protected _force: V2d = V();

  // Solver-internal properties (hidden from autocomplete via symbols)
  [SOLVER_VLAMBDA]: V2d = V();
  [SOLVER_WLAMBDA]: number = 0;

  // Abstract properties that subclasses must implement
  abstract get velocity(): V2d;
  abstract get angularVelocity(): number;
  abstract set angularVelocity(value: number);
  abstract get mass(): number;
  abstract get invMass(): number;
  abstract get invInertia(): number;

  // Force accumulators
  abstract get angularForce(): number;
  abstract set angularForce(value: number);

  // Solver-internal abstract properties (hidden via symbols)
  abstract get [SOLVER_INV_MASS](): number;
  abstract get [SOLVER_INV_INERTIA](): number;
  abstract [SOLVER_UPDATE_MASS](): void;
  abstract [SOLVER_ADD_VELOCITY](): void;

  constructor(options: BaseBodyOptions = {}) {
    super();

    this.id = options.id || ++Body._idCounter;

    if (options.position) {
      this.position.set(options.position);
    }

    this.angle = options.angle || 0;
    this.collisionResponse = options.collisionResponse ?? true;
  }

  // Force getter
  get force(): V2d {
    return this._force;
  }

  /** Reset constraint velocity accumulators to zero. (Solver internal) */
  [SOLVER_RESET_VELOCITY](): void {
    this[SOLVER_VLAMBDA].set(0, 0);
    this[SOLVER_WLAMBDA] = 0;
  }

  // Abstract methods that subclasses must implement
  abstract updateMassProperties(): this;
  abstract integrate(dt: number): void;

  /** Get the total area of all shapes in the body */
  getArea(): number {
    let totalArea = 0;
    for (let i = 0; i < this.shapes.length; i++) {
      totalArea += this.shapes[i].area;
    }
    return totalArea;
  }

  /** Get the AABB from the body. The AABB is updated if necessary. */
  getAABB(): AABB {
    if (this.aabbNeedsUpdate) {
      this.updateAABB();
    }
    return this.aabb;
  }

  /** Updates the AABB of the Body, and set .aabbNeedsUpdate = false. */
  updateAABB(): this {
    const shapes = this.shapes;
    const N = shapes.length;
    const bodyAngle = this.angle;

    for (let i = 0; i !== N; i++) {
      const shape = shapes[i];
      const angle = shape.angle + bodyAngle;

      // Get shape world offset
      const offset = V(shape.position);
      offset.irotate(bodyAngle);
      offset.iadd(this.position);

      // Get shape AABB
      const aabb = shape.computeAABB(offset, angle);

      if (i === 0) {
        this.aabb.copy(aabb);
      } else {
        this.aabb.extend(aabb);
      }
    }

    this.aabbNeedsUpdate = false;
    return this;
  }

  /**
   * Update the bounding radius of the body (this.boundingRadius).
   * Should be done if any of the shape dimensions or positions are changed.
   */
  updateBoundingRadius(): this {
    const shapes = this.shapes;
    const N = shapes.length;
    let radius = 0;

    for (let i = 0; i !== N; i++) {
      const shape = shapes[i];
      const offset = shape.position.magnitude;
      const r = shape.boundingRadius;
      if (offset + r > radius) {
        radius = offset + r;
      }
    }

    this.boundingRadius = radius;
    return this;
  }

  /**
   * Add a shape to the body. You can pass a local transform when adding a shape,
   * so that the shape gets an offset and angle relative to the body center of mass.
   * Will automatically update the mass properties and bounding radius.
   */
  addShape(shape: Shape, offset?: CompatibleVector, angle?: number): this {
    if (shape.body) {
      throw new Error("A shape can only be added to one body.");
    }
    shape.body = this;

    // Copy the offset vector
    if (offset) {
      shape.position.set(offset);
    } else {
      shape.position.set(0, 0);
    }

    shape.angle = angle || 0;

    this.shapes.push(shape);
    this.updateMassProperties();
    this.updateBoundingRadius();

    this.aabbNeedsUpdate = true;
    return this;
  }

  /** Remove a shape. */
  removeShape(shape: Shape): boolean {
    const idx = this.shapes.indexOf(shape);

    if (idx !== -1) {
      this.shapes.splice(idx, 1);
      this.aabbNeedsUpdate = true;
      shape.body = null;
      return true;
    } else {
      return false;
    }
  }

  /** Transform a world point to local body frame. */
  toLocalFrame(worldPoint: V2d): V2d {
    return V(worldPoint).itoLocalFrame(this.position, this.angle);
  }

  /** Transform a local point to world frame. */
  toWorldFrame(localPoint: V2d): V2d {
    return V(localPoint).itoGlobalFrame(this.position, this.angle);
  }

  /** Transform a world vector to local body frame. */
  vectorToLocalFrame(worldVector: V2d): V2d {
    return V(worldVector).irotate(-this.angle);
  }

  /** Transform a local vector to world frame. */
  vectorToWorldFrame(localVector: V2d): V2d {
    return V(localVector).irotate(this.angle);
  }

  /**
   * Check if the body is overlapping another body.
   * Note that this method only works if the body was added to a World
   * and if at least one step was taken.
   */
  overlaps(body: Body): boolean {
    return this.world!.overlapKeeper.bodiesAreOverlapping(this, body);
  }

  /** Get velocity of a point in the body. */
  getVelocityAtPoint(relativePoint: V2d): V2d {
    const result = V(relativePoint).icrossVZ(this.angularVelocity);
    return V(this.velocity).isub(result);
  }
}
