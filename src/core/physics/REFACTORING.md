# Physics Engine Refactoring Analysis

This document identifies C-style patterns in the physics engine and suggests TypeScript-idiomatic improvements.

## Table of Contents
1. [Type Field Antipattern](#1-type-field-antipattern)
2. [Classes With Excessive Fields](#2-classes-with-excessive-fields)
3. [Narrowphase Responsibilities](#3-narrowphase-responsibilities)
4. [Raycasting API](#4-raycasting-api)
5. [Other C-Style Patterns](#5-other-c-style-patterns)

---

## 1. Type Field Antipattern

Multiple class hierarchies use a `type` field assigned numeric constants, mimicking C-style type discrimination.

### Affected Classes

There are two distinct variations of this pattern:

#### Pattern A: Redundant Type Field (subclasses exist)

These hierarchies have actual subclasses, making the `type` field redundant - we could use `instanceof` instead.

**Shape Hierarchy** (`shapes/Shape.ts`):
```typescript
// Current pattern - type field is REDUNDANT
class Shape {
  type: number;
  static CIRCLE = 1;
  static PARTICLE = 2;
  // ...
}

class Circle extends Shape {
  constructor() {
    this.type = Shape.CIRCLE; // Redundant - we already know it's a Circle
  }
}

// Could just use: if (shape instanceof Circle)
```

**Constraint Hierarchy** (`constraints/Constraint.ts`):
- Subclasses: DistanceConstraint, LockConstraint, RevoluteConstraint
- `type` field is redundant since subclasses exist

**Solver Hierarchy** (`solver/Solver.ts`):
- Subclasses: GSSolver (presumably others)
- `type` field is redundant

#### Pattern B: No Subclasses (type field is the only discriminator)

**Body Class** (`body/Body.ts`):
- `Body.DYNAMIC = 1`
- `Body.STATIC = 2`
- `Body.KINEMATIC = 4`
- **No DynamicBody, StaticBody, or KinematicBody subclasses exist**
- The `type` field is the *only* way to differentiate behavior

This is a different problem - here the question is whether we *should* create subclasses, not whether the `type` field is redundant.

### Why Pattern A Is Problematic

1. **Redundancy**: We already have class identity via `instanceof`
2. **Magic Numbers**: Numeric constants are error-prone
3. **No Exhaustiveness Checking**: Switch statements can silently miss cases
4. **Maintenance Burden**: Must keep `type` assignment in sync with class hierarchy

### Why Pattern B Is Different

For Body, the `type` field serves a real purpose since there are no subclasses. The question is architectural: should there be DynamicBody/StaticBody/KinematicBody subclasses?

**Arguments for subclasses:**
- StaticBody doesn't need velocity, force, damping fields
- KinematicBody has different integration behavior
- Cleaner separation of concerns

**Arguments against:**
- Bodies can potentially change type at runtime
- Adds complexity to body creation
- Many physics operations work on all body types uniformly

### Usage Locations

The `type` field IS actively used:
- `SpatialHashingBroadphase.ts:75,81,89,92,315` - body type filtering
- `Broadphase.ts:63,69-70,76,87-88` - collision filtering
- `World.ts:229,248,507,509,566,569,581,584,663,665` - physics integration
- `IslandManager.ts:32,72` - dynamic body identification
- `Island.ts:44` - sleep logic

### Recommended Refactoring

#### For Pattern A (Shape, Constraint, Solver): Remove redundant type fields

**Option 1: Use instanceof** (simplest):
```typescript
// Instead of: if (shape.type === Shape.CIRCLE)
if (shape instanceof Circle) {
  // TypeScript knows shape is Circle
}
```

**Option 2: Discriminated union with string literals** (if instanceof isn't sufficient):
```typescript
class Circle extends Shape {
  readonly type = 'circle' as const;
}

class Box extends Shape {
  readonly type = 'box' as const;
}

// TypeScript can narrow based on type
```

#### For Pattern B (Body): Consider creating subclasses

This is a larger architectural decision. If pursued:

```typescript
abstract class Body {
  abstract readonly type: BodyType;
  // shared fields and methods
}

class DynamicBody extends Body {
  readonly type = BodyType.DYNAMIC;
  velocity: V2d;
  force: V2d;
  // dynamic-specific fields
}

class StaticBody extends Body {
  readonly type = BodyType.STATIC;
  // no velocity/force fields needed
}

class KinematicBody extends Body {
  readonly type = BodyType.KINEMATIC;
  velocity: V2d; // set directly, not from forces
}
```

Alternatively, just convert to an enum for type safety without creating subclasses:
```typescript
enum BodyType {
  DYNAMIC = 1,
  STATIC = 2,
  KINEMATIC = 4,
}

class Body {
  type: BodyType; // At least we get type safety
}
```

---

## 2. Classes With Excessive Fields

### Narrowphase (2142 lines, 18+ fields)

**Current fields:**
```typescript
contactEquations: ContactEquation[]
frictionEquations: FrictionEquation[]
enableFriction: boolean
enabledEquations: boolean
slipForce: number
frictionCoefficient: number
surfaceVelocity: number
contactEquationPool: ContactEquationPool
frictionEquationPool: FrictionEquationPool
restitution: number
stiffness: number
relaxation: number
frictionStiffness: number
frictionRelaxation: number
enableFrictionReduction: boolean
collidingBodiesLastStep: TupleDictionary
contactSkinSize: number
world: World
```

**Suggested Bundling:**
```typescript
interface ContactParameters {
  stiffness: number;
  relaxation: number;
  restitution: number;
  contactSkinSize: number;
}

interface FrictionParameters {
  enabled: boolean;
  coefficient: number;
  stiffness: number;
  relaxation: number;
  slipForce: number;
  surfaceVelocity: number;
  enableReduction: boolean;
}

class Narrowphase {
  contactParams: ContactParameters;
  frictionParams: FrictionParameters;
  // ... reduced to ~8 fields
}
```

### Body (734 lines, 24 fields)

**Fields that should be bundled:**

Sleep state (5 fields):
```typescript
interface SleepState {
  state: number;        // sleepState
  idleTime: number;
  timeLastSleepy: number;
  speedLimit: number;   // sleepSpeedLimit
  timeLimit: number;    // sleepTimeLimit
  wantsToSleep: boolean;
}
```

Interpolation (4 fields):
```typescript
interface InterpolationState {
  position: V2d;        // interpolatedPosition
  angle: number;        // interpolatedAngle
  previousPosition: V2d;
  previousAngle: number;
}
```

Solver state (4 fields):
```typescript
interface SolverState {
  vlambda: V2d;
  wlambda: number;
  invMassSolve: number;
  invInertiaSolve: number;
}
```

### World (880 lines, 21 fields)

**Suggested Bundling:**

Gravity configuration:
```typescript
interface GravityConfig {
  gravity: V2d;
  frictionGravity: number;
  useWorldGravityAsFrictionGravity: boolean;
  useFrictionGravityOnZeroGravity: boolean;
}
```

Physics flags:
```typescript
interface PhysicsFlags {
  applySpringForces: boolean;
  applyDamping: boolean;
  applyGravity: boolean;
  solveConstraints: boolean;
}
```

Time state:
```typescript
interface TimeState {
  time: number;
  accumulator: number;
  lastTimeStep: number;
}
```

---

## 3. Narrowphase Responsibilities

The `Narrowphase` class currently handles too many concerns:

### Current Responsibilities
1. **Collision Detection**: 20+ methods like `circleCircle()`, `convexConvex()`, etc.
2. **Friction Generation**: Creates and configures friction equations
3. **Equation Pooling**: Manages ContactEquationPool and FrictionEquationPool
4. **Collision Dispatch**: Dynamic method lookup via `[key: number]` properties (lines 329-362)
5. **Module-level temp vectors**: 50+ temporary vectors at module scope (lines 19-93) - these should just be moved to local scope where they're used

### Suggested Split

```
Narrowphase (current)
    |
    +-- CollisionDetector
    |       - All shape-vs-shape collision methods
    |       - Returns raw collision data (points, normals, depths)
    |
    +-- ContactGenerator
    |       - Creates ContactEquation from collision data
    |       - Handles restitution, stiffness, relaxation
    |
    +-- FrictionGenerator
            - Creates FrictionEquation from contacts
            - Handles friction coefficient, slip force
```

### Benefits
- Single Responsibility Principle
- Easier to test collision detection separately from equation generation
- Can swap collision algorithms without touching friction logic
- Clearer code organization

---

## 4. Raycasting API

### Current API (Clunky)

```typescript
// Must create and manage two objects
const result = new RaycastResult();
const ray = new Ray({
  from: [x1, y1],
  to: [x2, y2],
  mode: Ray.CLOSEST,
  checkCollisionResponse: true
});

// Must call update() after setting from/to
ray.from.set(position);
ray.to.set(target);
ray.update(); // Easy to forget!

// Perform raycast
world.raycast(result, ray);

// Must check before accessing
if (result.hasHit()) {
  const point = result.getHitPoint(ray); // Need ray again
  const distance = result.getHitDistance(ray);
}
```

### Problems

1. **Object Creation Overhead**: Must construct Ray and RaycastResult
2. **Mutable State**: Must call `update()` after modifying from/to
3. **Manual Reset**: Must call `result.reset()` before reuse
4. **Mode-Based Behavior**: `CLOSEST`, `ANY`, `ALL` modes dramatically change semantics
5. **Callback Pattern**: `ALL` mode uses callbacks, others don't
6. **Magic Sentinels**: Uses `-1` fraction for "no hit"
7. **Computed Values Not Cached**: `getHitPoint()` recomputes each call

### Suggested API

**Simple single-hit query:**
```typescript
const hit = world.raycast([x1, y1], [x2, y2]);
if (hit) {
  console.log(hit.body, hit.point, hit.normal, hit.distance);
}
```

**Multiple hits:**
```typescript
const hits = world.raycastAll([x1, y1], [x2, y2]);
for (const hit of hits) {
  console.log(hit.body, hit.point);
}
```

**With options:**
```typescript
const hit = world.raycast(startPos, endPos, {
  collisionMask: BULLET_MASK,
  skipBackfaces: true,
});
```

**Return type:**
```typescript
interface RaycastHit {
  body: Body;
  shape: Shape;
  point: V2d;      // Pre-computed, not fraction
  normal: V2d;
  distance: number; // Pre-computed
  fraction: number; // Still available if needed
}
```

### Implementation Approach

Keep internal Ray/RaycastResult for implementation efficiency, but expose simpler public methods:

```typescript
class World {
  // New simple API
  raycast(from: V2d, to: V2d, options?: RaycastOptions): RaycastHit | null {
    // Reuse internal ray/result objects
    this._ray.from.set(from);
    this._ray.to.set(to);
    this._ray.update();
    this._result.reset();

    // ... perform raycast ...

    if (this._result.hasHit()) {
      return {
        body: this._result.body!,
        shape: this._result.shape!,
        point: this._result.getHitPoint(this._ray),
        normal: V2d.clone(this._result.normal),
        distance: this._result.getHitDistance(this._ray),
        fraction: this._result.fraction,
      };
    }
    return null;
  }

  raycastAll(from: V2d, to: V2d, options?: RaycastOptions): RaycastHit[] {
    // Uses callback internally, returns array
  }
}
```

---

## 5. Other C-Style Patterns

### Module-Level Temporary Vectors

**Problem**: 50+ temporary vectors declared at module level in Narrowphase:
```typescript
// Narrowphase.ts lines 19-93
const tmp1 = V2d(0, 0);
const tmp2 = V2d(0, 0);
const tmp3 = V2d(0, 0);
// ... 50 more
```

**Issues:**
- Memory waste (always allocated even if narrowphase not used)
- Tight coupling between methods sharing temporaries
- Hard to reason about which temporaries are "in use"
- Confusing naming (`tmp1`, `tmp2`, etc.)

**Suggestion**: Move these to local scope within the functions that use them. Modern JS engines handle short-lived allocations efficiently, and the code becomes much clearer when variables are declared where they're used with meaningful names.

### Manual Reset Patterns

**Problem**: Multiple classes require manual `reset()` calls:
```typescript
result.reset();  // RaycastResult
body.resetConstraintVelocity(); // Body
```

**Suggestion**: Consider builder patterns or factory methods that return fresh instances, or make objects immutable where feasible.

### Magic Number Sentinels

**Problem**: Using `-1` to indicate "no hit":
```typescript
class RaycastResult {
  fraction: number = -1;

  hasHit(): boolean {
    return this.fraction !== -1;
  }
}
```

**Suggestion**: Use `null` or `undefined` for optional values:
```typescript
class RaycastResult {
  fraction: number | null = null;

  hasHit(): boolean {
    return this.fraction !== null;
  }
}
```

### Array-Based Vectors

**Current pattern** (in some places):
```typescript
const point: [number, number] = [x, y];
// or
const point: number[] = [x, y];
```

**Issue**: No type safety on array length, easy to confuse with other arrays.

**Better**: The codebase already uses `V2d` class which is good. Ensure consistent usage everywhere.

---

## Summary of Priorities

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| High | Narrowphase split | Improves maintainability significantly | Medium |
| High | Raycasting API | Better developer experience | Low-Medium |
| Medium | Type field cleanup | Better type safety, remove redundancy | Low |
| Medium | Body field bundling | Cleaner API | Medium |
| Low | Move temp vectors to local scope | Clearer code | Low |
| Low | Magic sentinels → null | Cleaner code | Low |

## Recommended Order of Refactoring

1. **Type fields to enums** - Low risk, immediate benefit
2. **Raycasting API wrapper** - Can add without changing internals
3. **Body field bundling** - Contained to one class
4. **Narrowphase split** - Larger change, do incrementally
5. **World field bundling** - After other patterns established
