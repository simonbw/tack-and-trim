import { CompatibleVector, V, V2d } from "../../Vector";
import type Body from "../body/Body";
import AABB from "../collision/AABB";
import type Ray from "../collision/Ray";
import type RaycastResult from "../collision/RaycastResult";
import type Material from "../material/Material";

export interface ShapeOptions {
  position?: CompatibleVector;
  angle?: number;
  collisionGroup?: number;
  collisionMask?: number;
  sensor?: boolean;
  collisionResponse?: boolean;
  type?: number;
  material?: Material | null;
}

/**
 * Base class for shapes.
 */
export default class Shape {
  static idCounter = 0;

  static readonly CIRCLE = 1;
  static readonly PARTICLE = 2;
  static readonly PLANE = 4;
  static readonly CONVEX = 8;
  static readonly LINE = 16;
  static readonly BOX = 32;
  static readonly CAPSULE = 64;
  static readonly HEIGHTFIELD = 128;

  /**
   * The body this shape is attached to.
   */
  body: Body | null = null;

  /**
   * Body-local position of the shape.
   */
  position: V2d;

  /**
   * Body-local angle of the shape.
   */
  angle: number;

  /**
   * The type of the shape.
   */
  type: number;

  /**
   * Shape object identifier.
   */
  id: number;

  /**
   * Bounding circle radius of this shape.
   */
  boundingRadius: number = 0;

  /**
   * Collision group that this shape belongs to (bit mask).
   */
  collisionGroup: number;

  /**
   * Whether to produce contact forces when in contact with other bodies.
   */
  collisionResponse: boolean;

  /**
   * Collision mask of this shape.
   */
  collisionMask: number;

  /**
   * Material to use in collisions for this Shape.
   */
  material: Material | null;

  /**
   * Area of this shape.
   */
  area: number = 0;

  /**
   * Set to true if you want this shape to be a sensor.
   */
  sensor: boolean;

  constructor(options: ShapeOptions = {}) {
    this.position = V();
    if (options.position) {
      this.position.set(options.position);
    }

    this.angle = options.angle ?? 0;
    this.type = options.type ?? 0;
    this.id = Shape.idCounter++;
    this.collisionGroup = options.collisionGroup ?? 1;
    this.collisionResponse = options.collisionResponse ?? true;
    this.collisionMask = options.collisionMask ?? 1;
    this.material = options.material ?? null;
    this.sensor = options.sensor ?? false;

    // Note: updateBoundingRadius() and updateArea() are NOT called here
    // because subclasses need to initialize their shape-specific properties first.
    // Each subclass (Circle, Convex, etc.) calls these methods in their own constructor.
  }

  /**
   * Should return the moment of inertia around the Z axis of the body given the total mass.
   */
  computeMomentOfInertia(_mass: number): number {
    return 0;
  }

  /**
   * Returns the bounding circle radius of this shape.
   */
  updateBoundingRadius(): void {
    // To be implemented in all subclasses
  }

  /**
   * Update the .area property of the shape.
   */
  updateArea(): void {
    // To be implemented in all subclasses
  }

  /**
   * Compute the world axis-aligned bounding box (AABB) of this shape.
   */
  computeAABB(_position: V2d, _angle: number): AABB {
    // To be implemented in each subclass
    return new AABB();
  }

  /**
   * Perform raycasting on this shape.
   */
  raycast(
    _result: RaycastResult,
    _ray: Ray,
    _position: V2d,
    _angle: number
  ): void {
    // To be implemented in each subclass
  }
}
