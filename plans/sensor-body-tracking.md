# Gameplan: Sensor Body Tracking

## Current State

**Files**:
- `src/core/physics/shapes/Shape.ts`
- `src/core/physics/world/World.ts`

### Current Pattern

Every narrowphase collision check tests if either shape is a sensor:

```typescript
// World.ts lines 351-372
private runNarrowphase(...): void {
  // ...
  const sensor = si.sensor || sj.sensor;
  if (sensor) {
    // For sensors, just check overlap without generating equations
    if (np.bodiesOverlap(bi, bj)) {
      // Track overlap but don't generate contact equations
    }
    return;
  }
  // ... full collision detection
}
```

**Problem**: The `si.sensor || sj.sensor` check happens for every shape pair. If we could identify sensor bodies upfront, we could potentially:
1. Skip unnecessary collision pair checks
2. Avoid generating collision equations entirely for sensor-only pairs

### Shape.ts sensor property

```typescript
// Shape.ts line 52
sensor: boolean;  // Set at construction, rarely changes
```

## Desired Changes

Track bodies that have at least one sensor shape. This is a good FilterSet candidate because:
- `sensor` is typically set at shape creation and doesn't change
- Checked every narrowphase call (high frequency)
- Subset is typically small

### Option A: Simple Set in BodyManager

Track bodies with sensor shapes when shapes are added.

### Option B: FilterSet for Bodies

Use FilterSet with predicate `(body) => body.shapes.some(s => s.sensor)`.

**Issue**: FilterSet checks predicate at add time, but shapes can be added to bodies after the body is added to the world.

### Option C: Sensor shape event tracking

Have Shape emit events when `sensor` changes, or track at narrowphase pair level.

## Recommendation

Given the complexity and the fact that sensor status rarely changes, **Option A** is simplest:

1. Check for sensor shapes when body is added to world
2. Track sensor bodies in a Set
3. If shapes can be added later, also check when shapes are added

However, this optimization may have limited benefit since the sensor check is already fast (just a boolean OR). The real cost is in the narrowphase itself, not the sensor check.

## Files to Modify (if proceeding)

- `src/core/physics/world/BodyManager.ts` - Add sensor body tracking
- `src/core/physics/body/Body.ts` - Possibly add event when shapes are added/removed

## Execution Order

1. Analyze actual performance impact first
2. If significant, implement Option A

## Alternative: Skip for now

The sensor check `si.sensor || sj.sensor` is O(1) - just two boolean reads and an OR. The optimization opportunity here is lower than the other items. Consider deferring this unless profiling shows it's a bottleneck.

## If Proceeding: Changes to `BodyManager.ts`

```typescript
export default class BodyManager implements Iterable<Body> {
  // ...

  /** Bodies that have at least one sensor shape */
  readonly withSensors: Set<Body> = new Set();

  add(body: Body): void {
    // ...

    // Check if body has sensor shapes
    for (const shape of body.shapes) {
      if (shape.sensor) {
        this.withSensors.add(body);
        break;
      }
    }
  }

  private removeImmediate(body: Body): void {
    // ...
    this.withSensors.delete(body);
  }
}
```

Then in World.runNarrowphaseForPairs():

```typescript
for (let i = 0; i < pairs.length; i += 2) {
  const bi = pairs[i];
  const bj = pairs[i + 1];

  // Quick check if either body has sensors
  const hasSensors = this.bodies.withSensors.has(bi) ||
                     this.bodies.withSensors.has(bj);

  // If neither has sensors, we can skip per-shape sensor checks
  // But we still need to do full narrowphase

  for (const si of bi.shapes) {
    for (const sj of bj.shapes) {
      // Original logic, but we could optimize further if !hasSensors
    }
  }
}
```

**Note**: This only provides benefit if we can skip work entirely for non-sensor pairs, but the current code structure already handles this efficiently.
