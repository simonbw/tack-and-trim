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

/** Sleep state for dynamic bodies. */
export enum SleepState {
  /** Body is active and simulated. */
  AWAKE = 0,
  /** Body is nearly idle and may sleep soon. */
  SLEEPY = 1,
  /** Body is sleeping and not simulated until woken. */
  SLEEPING = 2,
}

/** Options shared by all body types. */
export interface BaseBodyOptions {
  /** Initial position in world coordinates. */
  position?: CompatibleVector;
  /** Initial rotation angle in radians. */
  angle?: number;
  /** Custom body ID. Auto-generated if not provided. */
  id?: number;
  /** Whether this body produces contact forces. Default true. */
  collisionResponse?: boolean;
}

/**
 * Abstract base class for physics bodies. Use one of the concrete subclasses:
 * - {@link DynamicBody} - responds to forces, has mass
 * - {@link StaticBody} - immovable geometry
 * - {@link KinematicBody} - scripted motion
 */
export default abstract class Body extends EventEmitter<PhysicsEventMap> {
  /** @internal */
  static _idCounter = 0;

  /** Unique identifier for this body. */
  readonly id: number;
  /** The world this body belongs to, or null if not added. */
  world: World | null = null;

  /** Shapes attached to this body for collision detection. */
  shapes: Shape[] = [];
  /** Optional concave path for decomposition visualization. */
  concavePath: V2d[] | null = null;

  /** Position in world coordinates. */
  position: V2d = V();
  /** Rotation angle in radians. */
  angle: number = 0;

  /** Axis-aligned bounding box (call getAABB() for up-to-date value). */
  aabb: AABB = new AABB();
  /** @internal */
  aabbNeedsUpdate: boolean = true;
  /** Bounding circle radius encompassing all shapes. */
  boundingRadius: number = 0;

  /** Whether this body produces contact forces when colliding. */
  collisionResponse: boolean;

  /** @internal */
  _wakeUpAfterNarrowphase: boolean = false;

  /** @internal Force accumulator. */
  protected _force: V2d = V();

  /** @internal Constraint velocity accumulator (linear). */
  [SOLVER_VLAMBDA]: V2d = V();
  /** @internal Constraint velocity accumulator (angular). */
  [SOLVER_WLAMBDA]: number = 0;

  /** Current linear velocity. */
  abstract get velocity(): V2d;
  /** Current angular velocity in radians/second. */
  abstract get angularVelocity(): number;
  abstract set angularVelocity(value: number);
  /** Total mass of the body. */
  abstract get mass(): number;
  /** Inverse mass (1/mass), or 0 for infinite mass. */
  abstract get invMass(): number;
  /** Inverse moment of inertia, or 0 for infinite inertia. */
  abstract get invInertia(): number;

  /** Current angular force (torque) accumulator. */
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

  /** Recalculate mass and inertia from shapes. */
  abstract updateMassProperties(): this;
  /** @internal Integrate position and velocity forward by dt. */
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
