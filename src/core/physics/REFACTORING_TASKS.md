# Physics Module Refactoring Tasks

This document outlines the steps to modernize the physics module to match the rest of the codebase's TypeScript style.

## Task Groups Overview

Tasks are organized into independent groups that can be worked on in parallel. Within each group, tasks may have dependencies.

---

## Group A: Method Chaining (Return `this`)

**Goal:** Enable fluent API by returning `this` from setter/mutator methods.

**Can be parallelized:** Yes, each file is independent.

### A1. Body.ts - Add return `this`

**File:** `src/core/physics/body/Body.ts`

**Methods to modify:**
- `addShape()` - return `this` instead of `void`
- `removeShape()` - already returns `boolean`, keep as-is
- `setDensity()` - return `this`
- `setZeroForce()` - return `this`
- `applyForce()` - return `this`
- `applyForceLocal()` - return `this`
- `applyImpulse()` - return `this`
- `applyImpulseLocal()` - return `this`
- `wakeUp()` - return `this`
- `sleep()` - return `this`
- `updateAABB()` - return `this`
- `updateBoundingRadius()` - return `this`
- `updateMassProperties()` - return `this`
- `adjustCenterOfMass()` - return `this`

### A2. Constraint.ts - Add return `this`

**File:** `src/core/physics/constraints/Constraint.ts`

**Methods to modify:**
- `setStiffness()` - return `this`
- `setRelaxation()` - return `this`
- `update()` - return `this` (in subclasses too)

**Also update subclasses:**
- `src/core/physics/constraints/DistanceConstraint.ts`
- `src/core/physics/constraints/RevoluteConstraint.ts`
- `src/core/physics/constraints/GearConstraint.ts`
- `src/core/physics/constraints/LockConstraint.ts`
- `src/core/physics/constraints/PrismaticConstraint.ts`

### A3. Spring.ts - Add return `this`

**File:** `src/core/physics/springs/Spring.ts`

**Methods to modify:**
- `applyForce()` - return `this`

**Also update:**
- `src/core/physics/springs/LinearSpring.ts`
- `src/core/physics/springs/RotationalSpring.ts`

### A4. World.ts - Return boolean from add/remove

**File:** `src/core/physics/world/World.ts`

**Methods to modify:**
- `addBody()` - return `boolean` (true if added, false if already present)
- `removeBody()` - return `boolean` (true if removed/queued, false if not found)
- `addSpring()` - return `boolean`
- `removeSpring()` - return `boolean`
- `addConstraint()` - return `boolean`
- `removeConstraint()` - return `boolean`
- `addContactMaterial()` - return `boolean`

### A5. Shape.ts - Add return `this`

**File:** `src/core/physics/shapes/Shape.ts`

**Methods to modify:**
- `computeMomentOfInertia()` - keep as-is (returns number)
- `computeAABB()` - see Group C for out parameter change

### A6. AABB.ts - Add return `this`

**File:** `src/core/physics/collision/AABB.ts`

**Methods to modify:**
- `setFromPoints()` - return `this`
- `copy()` - return `this`
- `extend()` - return `this`
- `overlaps()` - keep as-is (returns boolean)
- `containsAABB()` - keep as-is (returns boolean)

### A7. Equation.ts - Add return `this`

**File:** `src/core/physics/equations/Equation.ts`

**Methods to modify:**
- `update()` - return `this`
- `addToWlambda()` - return `this`
- `computeInvC()` - keep as-is (returns number)

---

## Group B: Replace `defaults()` with Modern Patterns

**Goal:** Use spread operator and nullish coalescing instead of custom `defaults()` function.

**Can be parallelized:** Yes, each file is independent.

### B1. Remove Utils.defaults() usage

**Files to modify:**

1. `src/core/physics/springs/Spring.ts`
   - Replace `defaults(options, { stiffness: 100, damping: 1 })` with spread/nullish

2. `src/core/physics/springs/LinearSpring.ts`
   - Replace defaults usage in constructor

3. `src/core/physics/springs/RotationalSpring.ts`
   - Replace defaults usage in constructor

4. `src/core/physics/constraints/Constraint.ts`
   - Replace defaults usage in constructor

5. `src/core/physics/constraints/DistanceConstraint.ts`
   - Replace defaults usage

6. `src/core/physics/constraints/RevoluteConstraint.ts`
   - Replace defaults usage

7. `src/core/physics/constraints/GearConstraint.ts`
   - Replace defaults usage

8. `src/core/physics/constraints/LockConstraint.ts`
   - Replace defaults usage

9. `src/core/physics/constraints/PrismaticConstraint.ts`
   - Replace defaults usage

10. `src/core/physics/world/World.ts`
    - Replace defaults usage in constructor

11. `src/core/physics/body/Body.ts`
    - Replace defaults usage in constructor

12. `src/core/physics/solver/GSSolver.ts`
    - Replace defaults usage

13. `src/core/physics/collision/Ray.ts`
    - Replace defaults usage

**Pattern to use:**
```typescript
// Before
const opts = defaults(options, { stiffness: 100, damping: 1 });
this.stiffness = opts.stiffness;

// After
this.stiffness = options?.stiffness ?? 100;
this.damping = options?.damping ?? 1;
```

### B2. Remove defaults() from Utils.ts

**File:** `src/core/physics/utils/Utils.ts`

**After B1 is complete:** Remove the `defaults()` function export.

---

## Group C: Convert Out Parameters to Return Values

**Goal:** Methods should return computed values instead of modifying an "out" parameter.

**Can be parallelized:** Yes, but coordinate on shared interfaces.

### C1. Body.ts - Frame transformation methods

**File:** `src/core/physics/body/Body.ts`

**Methods to change:**
```typescript
// Before
toLocalFrame(out: V2d, worldPoint: V2d): void

// After
toLocalFrame(worldPoint: V2d): V2d
```

- `toLocalFrame()` - return new V2d
- `toWorldFrame()` - return new V2d
- `vectorToLocalFrame()` - return new V2d
- `vectorToWorldFrame()` - return new V2d
- `getVelocityAtPoint()` - return new V2d (currently in Body.ts around line 752)

**Update callers in:**
- `src/core/physics/collision/Narrowphase.ts`
- `src/core/physics/constraints/*.ts`
- `src/core/physics/springs/LinearSpring.ts`

### C2. Spring anchor methods

**Files:**
- `src/core/physics/springs/LinearSpring.ts`
- `src/core/physics/springs/RotationalSpring.ts`

**Methods to change:**
- `getWorldAnchorA(result: V2d): void` → `getWorldAnchorA(): V2d`
- `getWorldAnchorB(result: V2d): void` → `getWorldAnchorB(): V2d`
- `setWorldAnchorA(worldAnchor: V2d): void` - keep as-is (setter)
- `setWorldAnchorB(worldAnchor: V2d): void` - keep as-is (setter)

### C3. Shape AABB computation

**Files:**
- `src/core/physics/shapes/Shape.ts` (base class)
- `src/core/physics/shapes/Circle.ts`
- `src/core/physics/shapes/Box.ts`
- `src/core/physics/shapes/Convex.ts`
- `src/core/physics/shapes/Capsule.ts`
- `src/core/physics/shapes/Line.ts`
- `src/core/physics/shapes/Plane.ts`
- `src/core/physics/shapes/Heightfield.ts`
- `src/core/physics/shapes/Particle.ts`

**Method to change:**
```typescript
// Before
computeAABB(out: AABB, position: V2d, angle: number): void

// After
computeAABB(position: V2d, angle: number): AABB
```

**Update callers in:**
- `src/core/physics/body/Body.ts` (updateAABB method)

### C4. Convex projection methods

**File:** `src/core/physics/shapes/Convex.ts`

**Methods to change:**
- `projectOntoLocalAxis(localAxis: V2d, result: V2d)` → return `V2d`
- `projectOntoWorldAxis(...)` → return `V2d`

### C5. RaycastResult methods

**File:** `src/core/physics/collision/RaycastResult.ts`

**Methods to change:**
- `getHitPoint(out: V2d, ray: Ray): void` → `getHitPoint(ray: Ray): V2d`
- `getHitDistance(ray: Ray): number` - keep as-is (already returns)

### C6. AABB methods

**File:** `src/core/physics/collision/AABB.ts`

**Methods to change:**
- `setFromPoints()` currently returns void but modifies `this` - this is acceptable, just ensure it returns `this`

### C7. OverlapKeeper methods

**File:** `src/core/physics/utils/OverlapKeeper.ts`

**Methods to change:**
- `getDiff(dictA, dictB, result)` → `getDiff(dictA, dictB): OverlapKeeperRecord[]`

---

## Group D: Modernize Loop Patterns

**Goal:** Replace C-style `while (l--)` with standard loops.

**Can be parallelized:** Yes, each file is independent.

### D1. TupleDictionary.ts

**File:** `src/core/physics/utils/TupleDictionary.ts`

**Changes:**
- Line 59-65: Replace `while (l--)` with `for` loop in `reset()`
- Line 73-78: Replace `while (l--)` with `for` loop in `copy()`

### D2. OverlapKeeper.ts

**File:** `src/core/physics/utils/OverlapKeeper.ts`

**Changes:**
- Line 34: Replace `while (l--)` in `tick()`
- Line 86: Replace `while (l--)` in `getNewOverlaps()`
- Line 110: Replace `while (l--)` in `getDiff()`
- Line 153: Replace `while (l--)` in `getNewBodyOverlaps()`
- Line 161: Replace `while (l--)` in `getNewBodyOverlaps()`

### D3. AABB.ts

**File:** `src/core/physics/collision/AABB.ts`

**Changes:**
- Line 101-115: Replace `while (i--)` in `extend()` with standard loop

### D4. GSSolver.ts

**File:** `src/core/physics/solver/GSSolver.ts`

**Changes:**
- Line 13-18: Replace `while (l--)` in `setArrayZero()`
- Line 242-250: Replace `while (l--)` in `updateMultipliers()`

### D5. IslandManager.ts

**File:** `src/core/physics/world/IslandManager.ts`

**Changes:**
- Multiple `while` loops - convert to `for` loops

### D6. Narrowphase.ts

**File:** `src/core/physics/collision/Narrowphase.ts`

**Changes:**
- Line 101-111: Replace `while` loops in `reset()` with `for` loops

**Pattern to use:**
```typescript
// Before
let l = array.length;
while (l--) {
  doSomething(array[l]);
}

// After
for (let i = array.length - 1; i >= 0; i--) {
  doSomething(array[i]);
}
```

---

## Group E: Remove Bitwise Type Coercion

**Goal:** Replace `| 0` integer coercion with explicit methods or remove if unnecessary.

**Can be parallelized:** Yes, each file is independent.

### E1. TupleDictionary.ts

**File:** `src/core/physics/utils/TupleDictionary.ts`

**Changes:**
- Lines 14-26: Remove `| 0` coercion in `getKey()`
- Use `Math.floor()` if integer conversion is actually needed, or just remove if IDs are already integers

### E2. SAPBroadphase.ts

**File:** `src/core/physics/collision/SAPBroadphase.ts`

**Changes:**
- Line 68: Remove `axisIndex = axisIndex | 0`
- Line 114: Remove `| 0` from loop

### E3. OverlapKeeper.ts

**File:** `src/core/physics/utils/OverlapKeeper.ts`

**Changes:**
- Lines 130-131: Remove `| 0` coercion

### E4. polyk.ts

**File:** `src/core/physics/math/polyk.ts`

**Changes:**
- Line 52: Replace `p.length >> 1` with `Math.floor(p.length / 2)` or `p.length / 2` if always even

---

## Group F: Typed Event System

**Goal:** Replace mutable pooled event objects with discriminated union types.

**Dependencies:** Should be done as a unit.

### F1. Define event types

**File to create:** `src/core/physics/events/PhysicsEvents.ts`

```typescript
export type PhysicsEvent =
  | { type: 'addBody'; body: Body }
  | { type: 'removeBody'; body: Body }
  | { type: 'addSpring'; spring: Spring }
  | { type: 'removeSpring'; spring: Spring }
  | { type: 'impact'; bodyA: Body; bodyB: Body; shapeA: Shape; shapeB: Shape; contactEquation: ContactEquation }
  | { type: 'postBroadphase'; pairs: Body[] }
  | { type: 'beginContact'; shapeA: Shape; shapeB: Shape; bodyA: Body; bodyB: Body; contactEquations: ContactEquation[] }
  | { type: 'endContact'; shapeA: Shape; shapeB: Shape; bodyA: Body; bodyB: Body }
  | { type: 'preSolve'; contactEquations: ContactEquation[]; frictionEquations: FrictionEquation[] }
  | { type: 'postStep' }
  | { type: 'addShape'; body: Body; shape: Shape }
  | { type: 'removeShape'; body: Body; shape: Shape }
  | { type: 'sleep'; body: Body }
  | { type: 'wakeUp'; body: Body };
```

### F2. Update EventEmitter

**File:** `src/core/physics/events/EventEmitter.ts`

- Add generic type parameter for event map
- Type the `on()`, `off()`, `emit()` methods

### F3. Update World.ts

**File:** `src/core/physics/world/World.ts`

- Remove mutable event object properties (lines 88-156)
- Create fresh event objects when emitting
- Update all `emit()` calls

### F4. Update Body.ts events

**File:** `src/core/physics/body/Body.ts`

- Update sleep/wakeUp event emission

---

## Group G: Remove Module-Level Temp Vectors

**Goal:** Remove pre-allocated temporary vectors, allocate fresh ones in methods.

**Can be parallelized:** Yes, each file is independent.

**Note:** This may have performance implications. Consider profiling before/after.

### G1. Body.ts

**File:** `src/core/physics/body/Body.ts`

**Remove these module-level declarations (lines 34-56):**
```typescript
const shapeAABB = new AABB();
const tmp = V();
const Body_applyForce_r = V();
const Body_applyForce_forceWorld = V();
// ... etc (about 20 vectors)
```

**Update methods to allocate locally or use V2d's immutable methods.**

### G2. Narrowphase.ts

**File:** `src/core/physics/collision/Narrowphase.ts`

**Remove:**
```typescript
const bodiesOverlap_shapePositionA = V();
const bodiesOverlap_shapePositionB = V();
```

### G3. LinearSpring.ts

**File:** `src/core/physics/springs/LinearSpring.ts`

**Remove (lines 13-21):**
```typescript
const applyForce_r = V();
const applyForce_r_unit = V();
// ... etc
```

### G4. DistanceConstraint.ts

**File:** `src/core/physics/constraints/DistanceConstraint.ts`

**Remove (lines 15-17):**
```typescript
const n = V();
const ri = V();
const rj = V();
```

### G5. Other constraint files

**Files:**
- `src/core/physics/constraints/RevoluteConstraint.ts`
- `src/core/physics/constraints/PrismaticConstraint.ts`
- `src/core/physics/constraints/LockConstraint.ts`
- `src/core/physics/constraints/GearConstraint.ts`

**Remove module-level temp vectors from each.**

### G6. Convex.ts

**File:** `src/core/physics/shapes/Convex.ts`

**Remove (lines 13-22):**
```typescript
const tmpVec1 = V();
const tmpVec2 = V();
// ... etc
```

### G7. ContactEquation.ts

**File:** `src/core/physics/equations/ContactEquation.ts`

**Remove module-level temp vectors.**

### G8. AABB.ts

**File:** `src/core/physics/collision/AABB.ts`

**Remove:**
```typescript
const tmp = V();
```

### G9. Other files with temp vectors

**Check and clean:**
- `src/core/physics/collision/Ray.ts`
- `src/core/physics/collision/RaycastResult.ts`
- `src/core/physics/equations/FrictionEquation.ts`
- `src/core/physics/equations/RotationalLockEquation.ts`
- `src/core/physics/equations/RotationalVelocityEquation.ts`

---

## Group H: Remove Object Pooling

**Goal:** Remove explicit object pools, let GC handle memory.

**Dependencies:** Some pools are used across files.

### H1. Remove Pool class usage

**Files to modify:**

1. `src/core/physics/collision/Narrowphase.ts`
   - Remove `contactEquationPool` and `frictionEquationPool`
   - Replace `pool.get()` with `new ContactEquation(...)`
   - Remove `pool.release()` calls
   - Update `reset()` method

2. `src/core/physics/world/IslandManager.ts`
   - Remove `nodePool` and `islandPool`
   - Replace pool operations with direct instantiation

3. `src/core/physics/utils/OverlapKeeper.ts`
   - Remove `recordPool`
   - Replace pool operations with direct instantiation

### H2. Remove Pool classes

**Files to delete or deprecate:**
- `src/core/physics/utils/Pool.ts`
- `src/core/physics/utils/ContactEquationPool.ts`
- `src/core/physics/utils/FrictionEquationPool.ts`
- `src/core/physics/utils/IslandPool.ts`
- `src/core/physics/utils/IslandNodePool.ts`
- `src/core/physics/utils/OverlapKeeperRecordPool.ts`

### H3. Update index.ts exports

**File:** `src/core/physics/index.ts`

Remove pool exports if they were exported.

---

## Group I: Standardize Exports

**Goal:** Use consistent export patterns matching rest of codebase.

### I1. Utils.ts - Remove default export object

**File:** `src/core/physics/utils/Utils.ts`

**Change:**
```typescript
// Remove this pattern:
const Utils = { ARRAY_TYPE, appendArray, splice, extend };
export default Utils;

// Keep only named exports:
export { ARRAY_TYPE, appendArray, splice, extend };
```

**Update imports in other files** that use `import Utils from './utils/Utils'`

### I2. Review other utility exports

**Files to check:**
- `src/core/physics/math/polyk.ts` - Remove `PolyK` default export object

---

## Group J: Cleanup and Final Steps

**Dependencies:** Run after other groups complete.

### J1. Remove unused Utils functions

**File:** `src/core/physics/utils/Utils.ts`

After B2 completes, also consider removing:
- `extend()` - if not used elsewhere
- `ARRAY_TYPE` - if Float32Array is used directly everywhere

### J2. Update index.ts

**File:** `src/core/physics/index.ts`

- Remove exports for deleted pool classes
- Ensure all public API is properly exported

### J3. Run TypeScript compiler

```bash
npm run tsc
```

Fix any type errors from the refactoring.

### J4. Run tests

```bash
npm test
```

Ensure all physics tests pass.

---

## Parallelization Guide

**Fully independent (can all run in parallel):**
- Group A (all tasks)
- Group D (all tasks)
- Group E (all tasks)
- Group G (all tasks)

**Semi-independent (coordinate on interfaces):**
- Group B (B1 tasks parallel, then B2)
- Group C (coordinate on Shape interface changes)

**Sequential:**
- Group F (F1 → F2 → F3 → F4)
- Group H (H1 → H2 → H3)
- Group I (I1, then update imports)
- Group J (run last)

**Suggested parallel batches:**

```
Batch 1 (parallel):
├── A1, A2, A3, A4, A5, A6, A7
├── D1, D2, D3, D4, D5, D6
├── E1, E2, E3, E4
└── B1 (all files)

Batch 2 (parallel, after Batch 1):
├── B2
├── G1, G2, G3, G4, G5, G6, G7, G8, G9
└── I1, I2

Batch 3 (sequential):
├── C1 → C2 → C3 → C4 → C5 → C6 → C7
└── F1 → F2 → F3 → F4

Batch 4 (sequential):
└── H1 → H2 → H3

Batch 5 (final):
└── J1 → J2 → J3 → J4
```
