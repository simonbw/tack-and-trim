import FilterSet from "../../util/FilterSet";
import type Constraint from "../constraints/Constraint";

/** Manages constraints in the physics world. */
export default class ConstraintManager implements Iterable<Constraint> {
  private items = new Set<Constraint>();
  private dontCollideConnected = new FilterSet<Constraint, Constraint>(
    (constraint): constraint is Constraint => !constraint.collideConnected
  );

  /** Add a constraint to the world. */
  add(constraint: Constraint): void {
    this.items.add(constraint);
    this.dontCollideConnected.addIfValid(constraint);
  }

  /** Remove a constraint from the world. */
  remove(constraint: Constraint): void {
    this.items.delete(constraint);
    this.dontCollideConnected.remove(constraint);
  }

  /** Remove all constraints from the world. */
  clear(): void {
    this.items.clear();
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
}
