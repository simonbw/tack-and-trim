# Modifier System Rewrite Proposal

**Status**: ✅ COMPLETED

## Summary

Replace interface-based modifier system with class-based architecture integrated into the entity system. Shifts from CPU-based iteration to GPU buffer management.

## Current System (main branch)

**Architecture**: Interface-based duck typing
```typescript
interface WindModifier {
  getWindModifierPosition(): V2d;
  getWindModifierInfluenceRadius(): number;
  getWindVelocityContribution(queryPoint: V2d): V2d;
}

interface WaterModifier {
  getWaterModifierAABB(): AABB;
  getWaterContribution(queryPoint: V2d): WaterContribution;
}
```

**Implementation**:
- Any object can implement modifier interface
- Manual registration: `wind.registerModifier(sail)`
- CPU-based iteration with spatial hash
- Direct function calls for contribution calculation
- Manual cleanup required

## Proposed System (from analytical-water-shader-rewrite)

**Architecture**: Abstract base classes
```typescript
abstract class WaterModifier extends BaseEntity {
  abstract getBounds(): AABB;
  abstract getModifierData(): WaterModifierData;
}

type WaterModifierData =
  | { type: "wake"; strength: number; direction: number }
  | { type: "current"; velocity: { x: number; y: number } }
  | { type: "obstacle"; dampingFactor: number };
```

**Implementation**:
- Modifiers ARE entities in scene graph
- Automatic collection via `game.entities.byConstructor(WaterModifier)`
- GPU buffer holds all modifier data (16,384 max)
- Bounds culling in shader
- Automatic cleanup via entity lifecycle

## Key Benefits

1. **Type Safety** - Must extend base class, compiler ensures correct implementation
2. **Automatic Integration** - Entity system handles registration/cleanup
3. **GPU-Ready** - Data structures optimized for GPU upload
4. **Scalability** - Designed for 10,000+ modifiers with GPU parallelism
5. **Cleaner Architecture** - Consistent with rest of engine
6. **Easier Extension** - Adding new modifier types is straightforward

## Concrete Implementations

```typescript
export class WakeModifier extends WaterModifier {
  getBounds(): AABB { /* ... */ }
  getModifierData(): WaterModifierData {
    return { type: "wake", strength: this.strength, direction: this.direction };
  }
}

export class CurrentModifier extends WaterModifier {
  getBounds(): AABB { /* ... */ }
  getModifierData(): WaterModifierData {
    return { type: "current", velocity: this.velocity };
  }
}

export class ObstacleModifier extends WaterModifier {
  getBounds(): AABB { /* ... */ }
  getModifierData(): WaterModifierData {
    return { type: "obstacle", dampingFactor: this.dampingFactor };
  }
}
```

## GPU Buffer Management

```typescript
class WaterModifierBuffer {
  private buffer: GPUBuffer;

  update(modifiers: WaterModifier[]): void {
    const data = new Float32Array(modifiers.length * 8); // 8 floats per modifier

    for (let i = 0; i < modifiers.length; i++) {
      const bounds = modifiers[i].getBounds();
      const modData = modifiers[i].getModifierData();

      data[i * 8 + 0] = modData.type === "wake" ? 1 : modData.type === "current" ? 2 : 3;
      data[i * 8 + 1] = bounds.min.x;
      data[i * 8 + 2] = bounds.min.y;
      data[i * 8 + 3] = bounds.max.x;
      data[i * 8 + 4] = bounds.max.y;
      // ... pack type-specific data into [5-7]
    }

    device.queue.writeBuffer(this.buffer, 0, data);
  }
}
```

## Migration Path

### Phase 1: Create Base Classes
- Define `WaterModifier` abstract class
- Define `WaterModifierData` discriminated union
- Create `WaterModifierBuffer` for GPU upload

### Phase 2: Implement Concrete Modifiers
- `WakeModifier` for boat wakes
- `CurrentModifier` for local velocity fields
- `ObstacleModifier` for wave dampening

### Phase 3: Update Consumers
```typescript
// OLD
const sail = new Sail();
wind.registerModifier(sail);
// Later: wind.unregisterModifier(sail);

// NEW
const wake = new WakeModifier(position, strength, direction);
boat.addChild(wake);  // Parent-child relationship
// Cleanup happens automatically when boat destroyed
```

### Phase 4: Update Shaders
- Add modifier iteration to water compute shader
- Implement type discrimination: `switch(modifierType)`
- Apply contributions based on bounds culling

### Phase 5: Remove Old System
- Delete modifier interface files
- Remove manual registration code
- Clean up spatial hash implementations

## Wind Modifier Status

Note: The rewrite branch doesn't implement wind modifiers yet. The pattern would be identical:

```typescript
abstract class WindModifier extends BaseEntity {
  abstract getBounds(): AABB;
  abstract getModifierData(): WindModifierData;
}
```

Recommend deferring wind modifiers until water system is stable.

## Performance Comparison

**Old System:**
- CPU iteration: `O(N)` for N modifiers
- Spatial hash helps but still CPU-bound
- Hundreds of modifiers = frame drops

**New System:**
- GPU iteration: `O(N)` but massively parallel
- Bounds culling in shader with early-out
- 10,000+ modifiers = negligible cost

## Potential Issues

1. **GPU memory limit** - 16,384 modifiers × 32 bytes = 512 KB
   - **Mitigation**: More than sufficient for game's needs

2. **No CPU fallback** - Modifiers only work on GPU
   - **Mitigation**: Consistent with GPU-first architecture

3. **One-frame latency** - Modifier changes visible next frame
   - **Mitigation**: Acceptable for gameplay

## Recommendation

**RECOMMEND** adopting this change. The class-based approach is cleaner, more maintainable, and aligns with engine architecture. GPU-based application enables large-scale effects (particle systems, complex currents) that would be impossible with CPU iteration.

The migration is straightforward and the benefits are substantial.

## File References

**New System:**
- `src/game/world/water/WaterModifier.ts` (base class + implementations)
- `src/game/world/water/WaterModifierBuffer.ts` (GPU buffer manager)

**To Remove:**
- `src/game/WindModifier.ts` (interface)
- `src/game/water/WaterModifier.ts` (interface)
- Manual registration code in `Wind.ts` / `WaterInfo.ts`
