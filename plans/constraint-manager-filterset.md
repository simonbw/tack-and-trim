# Gameplan: ConstraintManager Non-Colliding FilterSet

## Current State

**Files**:
- `src/core/physics/world/ConstraintManager.ts`
- `src/core/physics/world/World.ts`

### Current Pattern

Every physics step, World loops through ALL constraints to filter out pairs where `collideConnected === false`:

```typescript
// World.ts lines 125-136
private runBroadphase(): Body[] {
  const pairs = this.broadphase.getCollisionPairs(this);

  // Remove constrained pairs with collideConnected == false
  for (const c of this.constraints) {
    if (!c.collideConnected) {  // Check every constraint
      for (let j = pairs.length - 2; j >= 0; j -= 2) {
        if (
          (c.bodyA === pairs[j] && c.bodyB === pairs[j + 1]) ||
          (c.bodyB === pairs[j] && c.bodyA === pairs[j + 1])
        ) {
          pairs.splice(j, 2);
        }
      }
    }
  }
  // ...
}
```

**Problem**: Most constraints have `collideConnected = false` (the default). We iterate all constraints when we could pre-filter.

### ConstraintManager Current State

```typescript
// ConstraintManager.ts - simple array storage
export default class ConstraintManager implements Iterable<Constraint> {
  private items: Constraint[] = [];

  add(constraint: Constraint): void {
    this.items.push(constraint);
  }

  remove(constraint: Constraint): void {
    const idx = this.items.indexOf(constraint);
    if (idx !== -1) {
      this.items.splice(idx, 1);
    }
  }
  // ...
}
```

## Desired Changes

Use FilterSet to maintain a separate collection of constraints where `!collideConnected`:

1. Add FilterSet import and instance to ConstraintManager
2. Filter constraints when added
3. Update World to iterate only the non-colliding constraints

## Files to Modify

- `src/core/physics/world/ConstraintManager.ts` - Add FilterSet for non-colliding constraints
- `src/core/physics/world/World.ts` - Use the filtered set

## Execution Order

### Sequential (has dependencies)

1. **First**: Update ConstraintManager to maintain filtered set
2. **Then**: Update World to use it

### Changes to `ConstraintManager.ts`

```typescript
import type Constraint from "../constraints/Constraint";
import FilterSet from "../../util/FilterSet";  // Import from core utils

// Type guard for non-colliding constraints
const isNonColliding = (c: Constraint): c is Constraint => !c.collideConnected;

export default class ConstraintManager implements Iterable<Constraint> {
  private items: Constraint[] = [];

  /** Constraints where collideConnected is false (should prevent body pair collisions) */
  readonly nonColliding: FilterSet<Constraint, Constraint>;

  constructor() {
    this.nonColliding = new FilterSet(isNonColliding);
  }

  add(constraint: Constraint): void {
    this.items.push(constraint);
    this.nonColliding.addIfValid(constraint);
  }

  remove(constraint: Constraint): void {
    const idx = this.items.indexOf(constraint);
    if (idx !== -1) {
      this.items.splice(idx, 1);
    }
    this.nonColliding.remove(constraint);
  }

  clear(): void {
    this.items.length = 0;
    this.nonColliding.clear();
  }

  // ...
}
```

### Changes to `World.ts`

```typescript
private runBroadphase(): Body[] {
  const pairs = this.broadphase.getCollisionPairs(this);

  // Remove constrained pairs with collideConnected == false
  // Only iterate constraints that have collideConnected = false
  for (const c of this.constraints.nonColliding) {
    for (let j = pairs.length - 2; j >= 0; j -= 2) {
      if (
        (c.bodyA === pairs[j] && c.bodyB === pairs[j + 1]) ||
        (c.bodyB === pairs[j] && c.bodyA === pairs[j + 1])
      ) {
        pairs.splice(j, 2);
      }
    }
  }

  this.emit({ type: "postBroadphase", pairs });
  return pairs;
}
```

### Note on FilterSet path

FilterSet is in `src/core/util/FilterSet.ts`. The import path from ConstraintManager would be:
```typescript
import FilterSet from "../../../util/FilterSet";
```

Or consider if FilterSet should be moved/re-exported somewhere more accessible.
