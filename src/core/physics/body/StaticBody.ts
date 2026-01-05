import { V, V2d } from "../../Vector";
import {
  SOLVER_ADD_VELOCITY,
  SOLVER_INV_INERTIA,
  SOLVER_INV_MASS,
  SOLVER_UPDATE_MASS,
} from "../internal";
import Body, { BaseBodyOptions } from "./Body";

export interface StaticBodyOptions extends BaseBodyOptions {
  // Static bodies don't need mass, velocity, etc.
}

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

  // Solver-internal getters (hidden from autocomplete via symbols)
  get [SOLVER_INV_MASS](): number {
    return 0;
  }

  get [SOLVER_INV_INERTIA](): number {
    return 0;
  }

  updateMassProperties(): this {
    // No-op for static bodies
    return this;
  }

  [SOLVER_UPDATE_MASS](): void {
    // No-op - invMassSolve is always 0
  }

  [SOLVER_ADD_VELOCITY](): void {
    // No-op - static bodies don't get velocity updates from constraints
  }

  integrate(_dt: number): void {
    // Static bodies don't move
  }
}
