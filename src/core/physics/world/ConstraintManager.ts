import { FilterSet } from "../../util/FilterSet";
import type { Constraint } from "../constraints/Constraint";
import { bodyKey } from "./OverlapKeeper";

/** Manages constraints in the physics world. */
export class ConstraintManager implements Iterable<Constraint> {
  private items = new Set<Constraint>();
  private dontCollideConnected = new FilterSet<Constraint, Constraint>(
    (constraint): constraint is Constraint => !constraint.collideConnected,
  );
  /** Cached body keys for constraints with collideConnected=false */
  private _disabledBodyKeys = new Set<string>();

  /** Add a constraint to the world. */
  add(constraint: Constraint): void {
    this.items.add(constraint);
    this.dontCollideConnected.addIfValid(constraint);
    if (!constraint.collideConnected) {
      this._disabledBodyKeys.add(bodyKey(constraint.bodyA, constraint.bodyB));
    }
  }

  /** Remove a constraint from the world. */
  remove(constraint: Constraint): void {
    this.items.delete(constraint);
    this.dontCollideConnected.remove(constraint);
    if (!constraint.collideConnected) {
      this._disabledBodyKeys.delete(
        bodyKey(constraint.bodyA, constraint.bodyB),
      );
    }
  }

  /** Remove all constraints from the world. */
  clear(): void {
    this.items.clear();
    this._disabledBodyKeys.clear();
  }

  /** Number of constraints in the collection. */
  get length(): number {
    return this.items.size;
  }

  [Symbol.iterator](): Iterator<Constraint> {
    return this.items[Symbol.iterator]();
  }

  get collideConnectedDisabled(): Iterable<Constraint> {
    return this.dontCollideConnected;
  }

  /** Pre-computed body keys for constraints with collideConnected=false */
  get disabledBodyKeys(): ReadonlySet<string> {
    return this._disabledBodyKeys;
  }
}
