# Gameplan: Physics Engine API Improvements

## Overview

Improve the physics engine's API ergonomics by hiding solver internals and using interface segregation so force methods are only available on DynamicBody.

---

## Current State

### Body Hierarchy (`src/core/physics/body/`)
- `Body` - Abstract base class with position, angle, shapes, coordinate transforms
- `DynamicBody` - Responds to forces, has mass, can sleep
- `StaticBody` - Never moves, infinite mass
- `KinematicBody` - Moves programmatically, doesn't respond to forces

### Problem 1: Solver Internals Exposed
The constraint solver needs access to internal state, but these are publicly visible:

**On Body (lines 86-117):**
- `vlambda`, `wlambda` - constraint velocity accumulators
- `invMassSolve`, `invInertiaSolve` - solve-time mass properties
- `resetConstraintVelocity()`, `addConstraintVelocity()`, `updateSolveMassProperties()`

**On Equation (lines 22-39):**
- `G` - constraint Jacobian (Float32Array)
- `B`, `invC`, `lambda` - solver temporaries
- `maxForceDt`, `minForceDt` - precomputed limits

These clutter autocomplete and confuse users who shouldn't touch them.

### Problem 2: Silent No-Op Force Methods
`StaticBody` and `KinematicBody` implement force methods as no-ops:

```typescript
// StaticBody.ts:69-72
applyForce(_force: V2d, _relativePoint?: V2d): this {
  // No-op - static bodies don't respond to forces
  return this;
}
```

This compiles but does nothing - a trap for users who don't realize static bodies can't be pushed.

---

## Desired Changes

### 1. Hide Solver Internals
Use TypeScript `Symbol` keys for solver-internal properties:
- Properties keyed by symbols don't appear in autocomplete
- Solver can still access them by importing the symbols
- Public API is clean and focused

### 2. Interface Segregation for Force Methods
Remove force/impulse methods from abstract `Body`:
- Only `DynamicBody` has `applyForce()`, `applyImpulse()`, etc.
- Calling `staticBody.applyForce()` becomes a compile error
- Springs require at least one `DynamicBody`

---

## New Types

### `src/core/physics/internal.ts` (new file)
```typescript
// Symbols for solver-internal properties
// Import these only in solver code, not in game code

export const SOLVER_VLAMBDA = Symbol('vlambda');
export const SOLVER_WLAMBDA = Symbol('wlambda');
export const SOLVER_INV_MASS = Symbol('invMassSolve');
export const SOLVER_INV_INERTIA = Symbol('invInertiaSolve');
export const SOLVER_RESET_VELOCITY = Symbol('resetConstraintVelocity');
export const SOLVER_ADD_VELOCITY = Symbol('addConstraintVelocity');
export const SOLVER_UPDATE_MASS = Symbol('updateSolveMassProperties');

// Equation internals
export const EQ_G = Symbol('G');
export const EQ_B = Symbol('B');
export const EQ_INV_C = Symbol('invC');
export const EQ_LAMBDA = Symbol('lambda');
```

---

## Files to Modify

### Part 1: Interface Segregation

#### `src/core/physics/body/Body.ts`
- Remove abstract declarations for: `applyForce`, `applyForceLocal`, `applyImpulse`, `applyImpulseLocal`, `applyDamping`, `setZeroForce`
- Keep: `updateMassProperties`, `updateSolveMassProperties`, `addConstraintVelocity`, `integrate`

#### `src/core/physics/body/StaticBody.ts`
- Remove: `applyForce`, `applyForceLocal`, `applyImpulse`, `applyImpulseLocal`, `applyDamping`, `setZeroForce`

#### `src/core/physics/body/KinematicBody.ts`
- Remove: `applyForce`, `applyForceLocal`, `applyImpulse`, `applyImpulseLocal`, `applyDamping`, `setZeroForce`

#### `src/core/physics/springs/Spring.ts`
- Change constructor signature: `bodyA: DynamicBody, bodyB: Body | null`
- At least one body must be dynamic for spring to have any effect
- If this creates friction, can revert to `Body` type

### Part 2: Hide Solver Internals

#### `src/core/physics/internal.ts` (new)
- Define all solver-internal symbols

#### `src/core/physics/body/Body.ts`
- Remove public getters: `vlambda`, `wlambda`
- Change storage to use symbols: `[SOLVER_VLAMBDA]: V2d`
- Remove from abstract interface: `invMassSolve`, `invInertiaSolve`, `resetConstraintVelocity`, `addConstraintVelocity`, `updateSolveMassProperties`

#### `src/core/physics/body/DynamicBody.ts`
- Use symbol keys for solver state
- Implement symbol-keyed methods

#### `src/core/physics/body/StaticBody.ts`
- Use symbol keys for solver state (returns zeros)

#### `src/core/physics/body/KinematicBody.ts`
- Use symbol keys for solver state (returns zeros)

#### `src/core/physics/equations/Equation.ts`
- Make `G`, `B`, `invC`, `lambda`, `maxForceDt`, `minForceDt` symbol-keyed
- Keep public: `stiffness`, `relaxation`, `enabled`, `minForce`, `maxForce`

#### `src/core/physics/solver/GSSolver.ts`
- Import symbols from `internal.ts`
- Access solver state via `body[SOLVER_VLAMBDA]`

#### `src/core/physics/world/World.ts`
- Update any solver-related access to use symbols

---

## Execution Order

### Phase 1: Interface Segregation (lower risk)
1. Edit `Body.ts` - remove abstract force method declarations
2. Edit `StaticBody.ts` - remove no-op force implementations
3. Edit `KinematicBody.ts` - remove no-op force implementations
4. Edit `Spring.ts` - update constructor to require `DynamicBody`
5. Run `npm run tsc` - fix any type errors in game code

**Checkpoint**: Force methods only exist on DynamicBody, type errors if misused

### Phase 2: Hide Solver Internals
1. Create `internal.ts` with all solver symbols
2. Edit `Body.ts` - replace public getters with symbol-keyed properties
3. Edit `DynamicBody.ts` - implement symbol-keyed solver methods
4. Edit `StaticBody.ts` - implement symbol-keyed solver methods
5. Edit `KinematicBody.ts` - implement symbol-keyed solver methods
6. Edit `Equation.ts` - hide solver temporaries behind symbols
7. Edit `GSSolver.ts` - import symbols, update all property access
8. Edit `World.ts` - update any solver-related access
9. Run `npm run tsc` - verify no regressions

**Checkpoint**: Autocomplete on Body shows only user-facing methods

---

## Testing Plan

1. **Type checking**: `npm run tsc` passes
2. **Runtime**: Game runs, physics behave identically
3. **Autocomplete**: Open VS Code, type `body.` on a `Body` variable - should not see `vlambda`, `wlambda`, etc.
4. **Compile errors**: Try `new StaticBody().applyForce(...)` - should fail to compile

---

## Rollback Plan

If symbol-based internals cause issues:
- Can revert to public properties with `@internal` JSDoc tag
- Less hidden, but documents intent

If `DynamicBody` requirement on springs causes friction:
- Revert Spring constructor to accept `Body`
- Add runtime warning if both bodies are non-dynamic
