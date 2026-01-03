# Gameplan: BodyManager Awake/Sleeping Tracking

## Current State

**Files**:
- `src/core/physics/world/BodyManager.ts`
- `src/core/physics/body/DynamicBody.ts`
- `src/core/physics/solver/GSSolver.ts`
- `src/core/physics/world/World.ts`

### Current Pattern

BodyManager already maintains separate Sets for body types:

```typescript
// BodyManager.ts
readonly dynamic: ReadonlySet<DynamicBody> = new Set();
readonly kinematic: ReadonlySet<KinematicBody> = new Set();
```

However, sleeping bodies are not tracked separately. Several hot paths iterate all dynamic bodies when they should skip sleeping ones:

**GSSolver.ts** (lines 92-100, 128-136, 215-223):
```typescript
const dynamicBodies = this.world?.bodies.dynamic;
for (const b of dynamicBodies) {
  b.updateSolveMassProperties();  // Wasted on sleeping bodies
}
```

**World.ts** (line 116):
```typescript
for (const body of this.bodies.dynamic) {
  body.applyDamping(dt);  // Wasted on sleeping bodies
}
```

### Existing Event Infrastructure

DynamicBody already emits events when sleep state changes:

```typescript
// DynamicBody.ts lines 290-310
wakeUp(): this {
  // ...
  this.emit({ type: "wakeup", body: this });
}

sleep(): this {
  // ...
  this.emit({ type: "sleep", body: this });
}
```

## Desired Changes

Add `awake` and `sleeping` Sets to BodyManager, maintained via event listeners:

1. BodyManager listens to `wakeup` and `sleep` events from DynamicBody
2. Move bodies between `awake` and `sleeping` Sets accordingly
3. Update consumers (GSSolver, World) to use `bodies.awake` instead of `bodies.dynamic`

## Files to Modify

- `src/core/physics/world/BodyManager.ts` - Add awake/sleeping Sets and event listeners
- `src/core/physics/body/DynamicBody.ts` - No changes needed (already emits events)
- `src/core/physics/solver/GSSolver.ts` - Use `bodies.awake` instead of `bodies.dynamic`
- `src/core/physics/world/World.ts` - Use `bodies.awake` for damping

## Execution Order

### Sequential (has dependencies)

1. **First**: Update BodyManager to track awake/sleeping Sets
2. **Then**: Update GSSolver and World to use the new Sets

### Changes to `BodyManager.ts`

```typescript
export default class BodyManager implements Iterable<Body> {
  readonly all: Body[] = [];
  readonly dynamic: ReadonlySet<DynamicBody> = new Set();
  readonly kinematic: ReadonlySet<KinematicBody> = new Set();

  // NEW: Awake/sleeping dynamic body tracking
  readonly awake: ReadonlySet<DynamicBody> = new Set();
  readonly sleeping: ReadonlySet<DynamicBody> = new Set();

  // ...

  add(body: Body): void {
    if (this.all.indexOf(body) !== -1) return;
    this.all.push(body);
    body.world = this.world;

    if (body instanceof DynamicBody) {
      (this.dynamic as Set<DynamicBody>).add(body);

      // Track initial sleep state and listen for changes
      if (body.sleepState === SleepState.SLEEPING) {
        (this.sleeping as Set<DynamicBody>).add(body);
      } else {
        (this.awake as Set<DynamicBody>).add(body);
      }

      body.on("wakeup", this.onBodyWakeUp);
      body.on("sleep", this.onBodySleep);
    } else if (body instanceof KinematicBody) {
      (this.kinematic as Set<KinematicBody>).add(body);
    }

    this.world.emit({ type: "addBody", body });
  }

  private removeImmediate(body: Body): void {
    // ...
    if (body instanceof DynamicBody) {
      (this.dynamic as Set<DynamicBody>).delete(body);
      (this.awake as Set<DynamicBody>).delete(body);
      (this.sleeping as Set<DynamicBody>).delete(body);

      body.off("wakeup", this.onBodyWakeUp);
      body.off("sleep", this.onBodySleep);
    }
    // ...
  }

  // Arrow functions to preserve `this`
  private onBodyWakeUp = (e: { body: DynamicBody }) => {
    (this.sleeping as Set<DynamicBody>).delete(e.body);
    (this.awake as Set<DynamicBody>).add(e.body);
  };

  private onBodySleep = (e: { body: DynamicBody }) => {
    (this.awake as Set<DynamicBody>).delete(e.body);
    (this.sleeping as Set<DynamicBody>).add(e.body);
  };
}
```

### Changes to `GSSolver.ts`

```typescript
// Replace:
const dynamicBodies = this.world?.bodies.dynamic;

// With:
const awakeBodies = this.world?.bodies.awake;
```

Update all three locations (lines ~92, ~128, ~215).

### Changes to `World.ts`

```typescript
// In applyForces():
// Replace:
for (const body of this.bodies.dynamic) {

// With:
for (const body of this.bodies.awake) {
```

### Import Requirements

BodyManager will need to import `SleepState` from Body.ts.
