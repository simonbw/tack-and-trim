import { V, V2d } from "../../Vector";
import Body, { BaseBodyOptions } from "./Body";

/** Options for creating a StaticBody. Same as BaseBodyOptions. */
export interface StaticBodyOptions extends BaseBodyOptions {}

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

  updateMassProperties(): this {
    // No-op for static bodies
    return this;
  }

  integrate(_dt: number): void {
    // Static bodies don't move
  }
}
