import type Entity from "../../entity/Entity";
import { CompatibleVector, V, V2d } from "../../Vector";
import { AABB } from "../collision/AABB";
import { EventEmitter } from "../events/EventEmitter";
import { PhysicsEventMap } from "../events/PhysicsEvents";
import type { Shape } from "../shapes/Shape";
import type { World } from "../world/World";

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
export abstract class Body extends EventEmitter<PhysicsEventMap> {
  /** @internal */
  static _idCounter = 0;

  // Shared arrays for 6DOF accessor defaults (non-6DOF bodies).
  // These must never be written to.
  /** @internal */ static readonly ZERO_3 = new Float64Array(3);
  /** @internal */ static readonly ZERO_9 = new Float64Array(9);
  /** @internal */ static readonly IDENTITY_3X3 = new Float64Array([
    1, 0, 0, 0, 1, 0, 0, 0, 1,
  ]);

  /** Unique identifier for this body. */
  readonly id: number;
  /** The world this body belongs to, or null if not added. */
  world: World | null = null;
  /** The Entity that owns this body, set by Game.addEntity(). */
  owner?: Entity;

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

  // ── 6DOF accessors (defaults for non-6DOF bodies) ──
  // Overridden by DynamicBody when sixDOF is enabled.
  // The solver reads these uniformly from any Body; defaults are zero/identity.

  /** Whether this body has 6DOF (z, roll, pitch) enabled. */
  get is6DOF(): boolean {
    return false;
  }
  /** Z position (vertical). Always 0 for non-6DOF bodies. */
  get z(): number {
    return 0;
  }
  set z(_v: number) {}
  /** Z velocity. Always 0 for non-6DOF bodies. */
  get zVelocity(): number {
    return 0;
  }
  set zVelocity(_v: number) {}
  /** Z force accumulator. Always 0 for non-6DOF bodies. */
  get zForce(): number {
    return 0;
  }
  set zForce(_v: number) {}
  /** Inverse mass for Z axis. 0 = immovable on Z. */
  get invMassZ(): number {
    return 0;
  }
  /** 3D angular velocity [wx, wy, wz] in world frame. Shared zero for non-6DOF. */
  get angularVelocity3(): Float64Array {
    return Body.ZERO_3;
  }
  /** 3D torque [tx, ty, tz] in world frame. Shared zero for non-6DOF. */
  get angularForce3(): Float64Array {
    return Body.ZERO_3;
  }
  /** 3x3 rotation matrix (row-major). Identity for non-6DOF (no tilt). */
  get orientation(): Float64Array {
    return Body.IDENTITY_3X3;
  }
  /** World-frame 3x3 inverse inertia tensor. Shared zero for non-6DOF. */
  get invWorldInertia(): Float64Array {
    return Body.ZERO_9;
  }

  // ── 3D transform helpers (defaults for non-6DOF bodies) ──

  /**
   * Compute the world Z-height of a body-local 3D point.
   * Non-6DOF bodies have no tilt, so returns localZ unchanged.
   */
  worldZ(_localX: number, _localY: number, localZ: number): number {
    return localZ;
  }

  /**
   * Transform a world 3D point to body-local coordinates [lx, ly, lz].
   * Non-6DOF bodies use 2D inverse rotation for x,y and return worldZ for z.
   */
  toLocalFrame3D(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): [number, number, number] {
    const c = Math.cos(-this.angle);
    const s = Math.sin(-this.angle);
    const dx = worldX - this.position[0];
    const dy = worldY - this.position[1];
    return [c * dx - s * dy, s * dx + c * dy, worldZ];
  }

  /**
   * Transform a body-local 3D point to world coordinates [wx, wy, wz].
   * Non-6DOF bodies use 2D toWorldFrame for x,y and return localZ for z.
   */
  toWorldFrame3D(
    localX: number,
    localY: number,
    localZ: number,
  ): [number, number, number] {
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return [
      c * localX - s * localY + this.position[0],
      s * localX + c * localY + this.position[1],
      localZ,
    ];
  }

  /**
   * Get the world-space X parallax offset for a given z-height.
   * Non-6DOF bodies have no tilt, so returns 0.
   */
  zParallaxX(_z: number): number {
    return 0;
  }

  /**
   * Get the world-space Y parallax offset for a given z-height.
   * Non-6DOF bodies have no tilt, so returns 0.
   */
  zParallaxY(_z: number): number {
    return 0;
  }

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
    return worldPoint.toLocalFrame(this.position, this.angle);
  }

  /** Transform a local point to world frame. */
  toWorldFrame(localPoint: V2d): V2d {
    return localPoint.toGlobalFrame(this.position, this.angle);
  }

  /** Transform a world vector to local body frame. */
  vectorToLocalFrame(worldVector: V2d): V2d {
    return worldVector.rotate(-this.angle);
  }

  /** Transform a local vector to world frame. */
  vectorToWorldFrame(localVector: V2d): V2d {
    return localVector.rotate(this.angle);
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
  getVelocityAtPoint(localPoint: V2d): V2d {
    return localPoint
      .crossVZ(this.angularVelocity)
      .imul(-1)
      .iadd(this.velocity); // this.velocity - velocityFromRotation
  }

  /** Get velocity of a point in the body. */
  getVelocityAtWorldPoint(worldPoint: V2d): V2d {
    return worldPoint
      .toLocalFrame(this.position, this.angle)
      .icrossVZ(this.angularVelocity)
      .imul(-1)
      .iadd(this.velocity);
  }
}
