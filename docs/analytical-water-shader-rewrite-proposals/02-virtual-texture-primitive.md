# VirtualTexture Primitive Proposal

**Status**: DEFERRED

## Summary

Add a generic GPU-accelerated tile streaming system with LOD support to core engine infrastructure. Replaces purpose-specific tile systems with a reusable, type-safe primitive.

## What is VirtualTexture?

A tile-based caching system for large static datasets that:

- Divides world space into 128×128 pixel tiles at multiple LOD levels
- Stores cached tiles in a GPU texture array
- Implements LRU eviction when cache is full
- Defers computation (max 8 tiles/frame) to prevent GPU stalls
- Provides LOD fallback chain for smooth degradation

## Current System (main branch)

No equivalent generic infrastructure. Terrain and other systems either:

- Compute on-demand with no caching
- Use purpose-specific tile implementations
- Lack LOD support

## Proposed System (from analytical-water-shader-rewrite)

Generic infrastructure in `core/graphics/webgpu/virtual-texture/`:

```typescript
class VirtualTexture<B extends BindingsDefinition> {
  constructor(config: {
    tileSize: number; // 128 for now
    maxTiles: number; // Cache size (256-512)
    tileCompute: TileCompute<B>; // Shader for generating tiles
    format: GPUTextureFormat; // r32float, rg32float, etc.
  });
}
```

### Use Cases in Branch

1. **Terrain Height Maps** - Cache Catmull-Rom spline evaluation results
2. **Wave Shadow Textures** - Cache shadow polygons per wave direction
3. **Future**: Normal maps, flow fields, any large static data

## Key Benefits

1. **Generic and Reusable** - Single implementation works for any tile-based data
2. **Type-Safe** - Uses TypeScript generics with shader binding definitions
3. **LOD Support** - Automatic resolution selection and fallback
4. **Smart Caching** - LRU eviction, demand-driven computation
5. **Performance Control** - Configurable tiles-per-frame limit prevents stalls
6. **Core Infrastructure** - Lives in engine, not game-specific code

## Migration Path

### Phase 1: Add Core Infrastructure

Copy from analytical-water-shader-rewrite:

- `src/core/graphics/webgpu/virtual-texture/VirtualTexture.ts`
- `src/core/graphics/webgpu/virtual-texture/TileCache.ts`
- `src/core/graphics/webgpu/virtual-texture/TileCompute.ts`

### Phase 2: Migrate Terrain System

- Implement `TerrainTileCompute` shader
- Replace current terrain computation with VirtualTexture
- Add to `TerrainSystem`

### Phase 3: Migrate Wave Shadows

- Implement `ShadowTileCompute` shader
- Add VirtualTexture to `WaveShadow` entities
- One VirtualTexture per wave direction

### Phase 4: Optimize and Extend

- Profile tile computation costs
- Tune cache sizes per use case
- Consider additional use cases (normal maps, etc.)

## Implementation Details

### Example: Terrain Height Tiles

```typescript
class TerrainSystem {
  private virtualTexture: VirtualTexture<typeof TerrainTileCompute.bindings>;

  constructor() {
    this.virtualTexture = new VirtualTexture({
      tileSize: 128,
      maxTiles: 256,
      tileCompute: new TerrainTileCompute(),
      format: "r32float", // Single channel: height
    });
  }

  @on("tick")
  onTick(dt: number) {
    const viewport = this.game.camera.getWorldViewport();
    this.virtualTexture.requestTilesForRect(viewport, 0 /* LOD */);
    this.virtualTexture.update(dt);
  }
}
```

### Performance Characteristics

- **Tile size**: 128×128 = 16,384 pixels
- **Workgroup size**: 8×8 = 64 threads
- **Max cache**: 256-512 tiles = 4-8 MB (for r32float)
- **Computation cap**: 8 tiles/frame = ~131K pixels/frame

## Potential Issues

1. **Complexity** - Adds sophisticated caching system to engine
   - **Mitigation**: Well-encapsulated, clean API, comprehensive documentation

2. **Memory usage** - Fixed texture array allocation
   - **Mitigation**: Configurable cache sizes per use case

3. **LOD transitions** - Potential for visible popping
   - **Mitigation**: Fallback chain ensures gradual degradation

## Recommendation

**RECOMMEND** adopting this as core engine infrastructure. The VirtualTexture is well-designed, production-ready, and provides significant value for any tile-based data. The implementation quality is high (zero `any` types, comprehensive tests).

Consider this a foundational primitive that will enable future features beyond terrain/shadows.

## File References

**New Files:**

- `src/core/graphics/webgpu/virtual-texture/VirtualTexture.ts`
- `src/core/graphics/webgpu/virtual-texture/TileCache.ts`
- `src/core/graphics/webgpu/virtual-texture/TileCompute.ts`

**Example Usage:**

- `src/game/world/terrain/TerrainSystem.ts`
- `src/game/world/terrain/TerrainTileCompute.ts`
- `src/game/world/water/WaveShadow.ts`
- `src/game/world/water/ShadowTileCompute.ts`
