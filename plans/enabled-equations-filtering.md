# Gameplan: Enabled Equations Filtering

## Current State

**File**: `src/core/physics/solver/Solver.ts`

### Current Pattern

When adding equations to the solver, each equation is checked for `enabled`:

```typescript
// Solver.ts lines 74-91
addEquation(eq: Equation): void {
  if (eq.enabled) {
    this.equations.push(eq);
  }
}

addEquations(eqs: Equation[]): void {
  for (let i = 0, N = eqs.length; i !== N; i++) {
    const eq = eqs[i];
    if (eq.enabled) {
      this.equations.push(eq);
    }
  }
}
```

### Where enabled state changes

The `enabled` property is dynamic - constraints can enable/disable equations:

```typescript
// DistanceConstraint.ts lines 161, 165
if (position < lowerLimit) {
  this.lowerLimitEquation.enabled = true;  // Dynamic!
} else {
  this.lowerLimitEquation.enabled = false;  // Dynamic!
}
```

## Analysis

**Why FilterSet won't work well here:**

1. `enabled` state changes every frame based on constraint limits
2. FilterSet checks predicates at add/remove time, not when properties change
3. Would need event emission every time `enabled` changes - significant overhead

**Current approach is actually reasonable:**

1. The `if (eq.enabled)` check is O(1)
2. It happens once per equation per solve step
3. The alternative (event-based tracking) would have higher overhead

## Recommendation: Keep Current Approach

The enabled check is:
- Simple boolean check (fast)
- Only happens once per equation per solve
- Not in a hot inner loop (solving iterations don't re-check enabled)

The overhead of event-based tracking (emitting events, maintaining Sets, etc.) would likely exceed the cost of the simple boolean check.

## Alternative Considered and Rejected

### FilterSet Approach (Not Recommended)

```typescript
// Would require:
// 1. Equation.enabled setter to emit events
set enabled(value: boolean) {
  if (this._enabled !== value) {
    this._enabled = value;
    this.emit({ type: value ? 'enabled' : 'disabled', equation: this });
  }
}

// 2. Solver to maintain FilterSet
private enabledEquations: FilterSet<Equation, Equation>;

// 3. Event listeners on every equation
// This is too much overhead for a simple boolean check
```

## Files to Modify

None - keep current implementation.

## Action

**Skip this optimization.** The current approach is already efficient for this use case. The enabled check is not a performance bottleneck.

Focus optimization efforts on the other items which have clearer benefits:
- Island.ts bodyIds (O(n²) → O(n))
- IslandManager multiple patterns (O(n²) → O(n))
- SpatialHashingBroadphase (O(n²) → O(n))
- BodyManager awake tracking (skip sleeping bodies entirely)
- ConstraintManager non-colliding (pre-filtered iteration)
