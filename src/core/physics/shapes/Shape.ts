import { CompatibleVector, V, V2d } from "../../Vector";
import type Body from "../body/Body";
import AABB from "../collision/AABB";
import type { ShapeRaycastHit } from "../collision/raycast/RaycastHit";
import type Material from "../material/Material";

export interface ShapeOptions {
  position?: CompatibleVector;
  angle?: number;
  collisionGroup?: number;
  collisionMask?: number;
  sensor?: boolean;
  collisionResponse?: boolean;
  material?: Material;
}

/** Base class for shapes. */
export default abstract class Shape {
  static idCounter = 0;

  /** The body this shape is attached to. */
  body: Body | null = null;

  /** Body-local position of the shape. */
  position: V2d;

  /** Body-local angle of the shape. */
  angle: number;

  /** Shape object identifier. */
  id: number;

  /** Bounding circle radius of this shape. */
  boundingRadius: number = 0;

  /** Collision group that this shape belongs to (bit mask). */
  collisionGroup: number;

  /** Whether to produce contact forces when in contact with other bodies. */
  collisionResponse: boolean;

  /** Collision mask of this shape. */
  collisionMask: number;

  /** Material to use in collisions for this Shape. */
  material?: Material;

  /** Area of this shape. */
  area: number = 0;

  /** Set to true if you want this shape to be a sensor. */
  sensor: boolean;

  constructor(options: ShapeOptions = {}) {
    this.position = V();
    if (options.position) {
      this.position.set(options.position);
    }

    this.angle = options.angle ?? 0;
    this.id = Shape.idCounter++;
    this.collisionGroup = options.collisionGroup ?? 1;
    this.collisionResponse = options.collisionResponse ?? true;
    this.collisionMask = options.collisionMask ?? 1;
    this.material = options.material;
    this.sensor = options.sensor ?? false;

    // Note: updateBoundingRadius() and updateArea() are NOT called here
    // because subclasses need to initialize their shape-specific properties first.
    // Each subclass (Circle, Convex, etc.) calls these methods in their own constructor.
  }

  /** Should return the moment of inertia around the Z axis of the body given the total mass. */
  computeMomentOfInertia(_mass: number): number {
    return 0;
  }

  /** Returns the bounding circle radius of this shape. */
  abstract updateBoundingRadius(): void;

  /** Update the .area property of the shape. */
  abstract updateArea(): void;

  /** Compute the world axis-aligned bounding box (AABB) of this shape. */
  abstract computeAABB(position: V2d, angle: number): AABB;

  /**
   * Perform raycasting on this shape.
   * @param from - Ray start point in world coordinates
   * @param to - Ray end point in world coordinates
   * @param position - Shape position in world coordinates
   * @param angle - Shape angle in world coordinates
   * @param skipBackfaces - Whether to skip hits on back faces
   * @returns Hit result or null if no hit
   */
  abstract raycast(
    from: V2d,
    to: V2d,
    position: V2d,
    angle: number,
    skipBackfaces: boolean
  ): ShapeRaycastHit | null;
}
