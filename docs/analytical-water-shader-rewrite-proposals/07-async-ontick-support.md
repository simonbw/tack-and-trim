# Async `onTick` Handler Support Proposal

**Status**: ✅ COMPLETED

## Summary

Add comprehensive async handler support to the game engine with zero overhead for synchronous handlers. Enables proper GPU query synchronization while maintaining performance.

## Current System (main branch)

All event handlers are synchronous:
```typescript
type EventHandler<EventMap> = {
  [K in keyof EventMap]: (eventData: EventMap[K]) => void;
};
```

Game loop is synchronous, fire-and-forget for all events.

## Proposed System (from analytical-water-shader-rewrite)

Event handlers can return `Promise<void>`:
```typescript
type EventHandler<EventMap> = {
  [K in keyof EventMap]: (eventData: EventMap[K]) => void | Promise<void>;
};
```

Game loop awaits async handlers with **zero overhead for sync handlers**.

## Key Implementation

### Zero-Overhead Async Dispatch

```typescript
private async dispatchTickForLayer(
  layerName: TickLayerName,
  dt: number,
): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const entity of this.entities.getTickersOnLayer(layerName)) {
    const result = entity.onTick?.(dt);
    // Only collect actual Promises
    if (result && result instanceof Promise) {
      promises.push(result);
    }
  }

  // Only await if there were any Promises
  if (promises.length > 0) {
    await Promise.all(promises);
  }
}
```

**Performance**:
- **Sync handlers**: Called normally, result is `undefined`, no overhead
- **Async handlers**: Collected and awaited with `Promise.all()` (parallel execution)
- **Zero overhead** when no async handlers on a layer

### Async Game Loop

```typescript
@profile
private async loop(time: number): Promise<void> {
  await this.tick(this.tickDuration);  // Waits for async handlers

  // Physics and rendering...

  // Request next frame at END to prevent concurrent loops
  this.animationFrameId = window.requestAnimationFrame((t) => this.loop(t));
}
```

**Critical**: `requestAnimationFrame` moved to end prevents concurrent loops.

### Profiler Support

```typescript
measure<T>(label: string, fn: () => T): T {
  this.start(label);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => this.end(label)) as T;
    }
    this.end(label);
    return result;
  } catch (err) {
    this.end(label);
    throw err;
  }
}
```

Properly times async operations without breaking sync code.

## Primary Use Case: GPU Query System

### One-Tick Latency Pipeline

```typescript
class WaterQueryManager {
  @on("tick")
  async onTick(_dt: number): Promise<void> {
    // Wait for GPU results from previous tick
    if (this.mappedPromise) {
      await this.mappedPromise;
    }

    // Read and distribute results
    if (this.hasMappedResults) {
      this.readAndDistributeResults();
      this.hasMappedResults = false;
    }
  }

  @on("afterPhysicsStep")
  onAfterPhysicsStep(_dt: number): void {
    // Collect points, dispatch GPU compute, start async readback
  }
}
```

**Why essential**: GPU `mapAsync()` returns promises. Without waiting, entities receive stale data.

## Migration Path

### Phase 1: Type System Updates
1. Update `EventHandler` type to allow `Promise<void>` return
2. Update `EventHandlerName` type generation
3. Verify TypeScript compilation

### Phase 2: Game Loop Changes
1. Make `loop()` method async
2. Make `tick()` method async
3. Implement `dispatchTickForLayer()` with promise collection
4. Move `requestAnimationFrame` to end of loop

### Phase 3: Profiler Updates
1. Update `measure()` to handle promises
2. Verify profiling accuracy for async operations

### Phase 4: Testing
1. Verify sync handlers still work (backward compatibility)
2. Test async handlers in query system
3. Profile performance overhead

### Phase 5: Documentation
1. Document async handler patterns
2. Add examples for async `onTick`
3. Note one-frame latency implications

## Potential for Wider Use

### Currently Supported

Only `onTick` is specially handled with async-aware dispatch. Other events use generic `dispatch()` which is synchronous.

### Could Support Async

These events could benefit from async support:
1. **`onAdd`** - Asynchronous resource loading during initialization
2. **`onDestroy`** - Async cleanup operations
3. **`frameEnd`** - End-of-frame operations (screenshots, telemetry)
4. **Custom events** - Already represent async operations

### Should NOT Be Async

1. **`onRender`** - Must be synchronous for consistent frame timing
2. **Physics events** - Need deterministic, immediate execution

### To Expand Support

Update `dispatch()` method with same pattern:
```typescript
async dispatch<EventName extends keyof GameEventMap>(
  eventName: EventName,
  data: GameEventMap[EventName],
) {
  const promises: Promise<void>[] = [];

  for (const entity of handlers) {
    const result = handler.call(entity, data);
    if (result && result instanceof Promise) {
      promises.push(result);
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}
```

**Caution**: Makes calling code async, creating cascade through game loop.

## Performance Characteristics

- **Type check**: `result instanceof Promise` is fast (~1ns)
- **Array allocation**: Only when promises exist
- **Promise.all()**: Runs handlers in parallel (minimal latency)
- **Profiling**: Properly times async operations
- **Overhead**: Zero for synchronous handlers

## Potential Issues

1. **One-tick latency** for GPU query results
   - **Mitigation**: Already present, designed into system

2. **Game loop can stall** if async handlers are slow
   - **Mitigation**: Document performance implications, use profiler

3. **Cascading async** if expanded to other events
   - **Mitigation**: Keep async limited to specific events

## Recommendation

**RECOMMEND** adopting for `onTick` support (required for query system). The implementation is sophisticated, zero-overhead for sync code, and essential for GPU synchronization.

**DEFER** expansion to other events until specific use cases arise. The current scope (tick only) is well-justified and low-risk.

Consider this foundational infrastructure that enables GPU-based gameplay features.

## File References

**Updated Files:**
- `src/core/entity/EventHandler.ts` (type system)
- `src/core/Game.ts` (async loop, dispatch)
- `src/core/util/Profiler.ts` (async measure)

**Primary Consumer:**
- `src/game/world/query/QueryManager.ts`
