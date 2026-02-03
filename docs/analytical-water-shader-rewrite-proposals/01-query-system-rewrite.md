# Query System Rewrite Proposal

## Summary

Replace the hybrid tile-based caching system with a pure GPU-only, point-based query system. This represents a fundamental architectural shift from complex tile management to simple point collection and GPU compute.

## Current System (main branch)

- **WaterInfo/TerrainInfo/WindInfo** entities manage both GPU tiles and CPU fallback
- **QueryForecast** system where entities predict their query patterns
- **DataTileManager** scores and selects tiles based on forecasts
- **Hybrid CPU/GPU** approach with parallel implementations
- **One frame latency** already present for GPU tile readback

## Proposed System (from analytical-water-shader-rewrite)

- **WaterQuery/TerrainQuery/WindQuery** entities created by consumers
- **QueryManager** base class handles point collection, GPU dispatch, and readback
- **GPU-only** computation with no CPU fallback
- **Point-based** approach - compute exactly what's needed
- **Simpler API** - entities provide points directly via callback

## Key Benefits

1. **Dramatic Simplification** - Removes ~1000+ lines of tile management and CPU fallback code
2. **Precise Results** - Entities get exact computation for exact points requested
3. **Deterministic** - Single GPU path means consistent behavior across machines
4. **Better API** - Iterator pattern for results, clear point-result correspondence
5. **GPU-First** - Embraces compute shaders as the solution, not an optimization

## Migration Path

### Phase 1: Core Infrastructure
- Implement `BaseQuery<TResult>` and `QueryManager<TResult>` base classes
- Create `WaterQueryManager`, `TerrainQueryManager`, `WindQueryManager`
- Set up GPU buffer management with double-buffering
- Define result layouts (stride, field offsets)

### Phase 2: Implement Query Types
- Create `WaterQuery`, `TerrainQuery`, `WindQuery` entity classes
- Implement compute shaders for each query type
- Add integration to `WorldManager`

### Phase 3: Migrate Consumers
Update entities to use new query API:

```typescript
// OLD
class Boat {
  tags = ["waterQuerier"];
  getWaterQueryForecast() { return {...}; }
  onTick() {
    const waterInfo = this.game.entities.getSingleton(WaterInfo);
    const state = waterInfo.getStateAtPoint(position);
  }
}

// NEW
class Boat {
  private waterQuery: WaterQuery;
  constructor() {
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.hull.vertices.map(v => this.localToWorld(v)))
    );
  }
  onTick() {
    for (const [point, result] of this.waterQuery) {
      // Use result.surfaceHeight, result.velocity
    }
  }
}
```

### Phase 4: Remove Old System
- Delete `world-data/datatiles/` folder
- Delete `cpu/` computation folders
- Remove forecast interfaces
- Clean up unused code

## Potential Issues

1. **No spatial caching** means redundant computation if multiple entities query nearby points
   - **Mitigation**: GPU parallelism makes this cheap; typical query counts are well within GPU capacity

2. **One frame latency required** (no CPU fallback for immediate results)
   - **Mitigation**: Already present in current system; gameplay designed around this

3. **GPU dependency** - no graceful degradation if GPU unavailable
   - **Mitigation**: WebGPU already required; rare edge case not worth complexity

## Recommendation

**STRONGLY RECOMMEND** adopting this change. The simplification is enormous, the API is cleaner, and the architecture is more maintainable. The trade-offs (no CPU fallback, potential redundant computation) are acceptable given the engine already requires WebGPU and typical query loads are modest.

## File References

**New System:**
- `src/game/world/query/QueryManager.ts`
- `src/game/world/query/BaseQuery.ts`
- `src/game/world/query/WaterQuery.ts`
- `src/game/world/query/TerrainQuery.ts`
- `src/game/world/query/WindQuery.ts`

**To Remove:**
- `src/game/world-data/datatiles/` (entire folder)
- `src/game/world-data/water/cpu/` (entire folder)
- `src/game/world-data/terrain/cpu/` (entire folder)
- `src/game/world-data/water/WaterQuerier.ts`
- `src/game/world-data/terrain/TerrainQuerier.ts`
