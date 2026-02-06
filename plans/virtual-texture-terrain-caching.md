# Virtual Texture Terrain Caching

## Current State

### Surface Rendering Pipeline

The surface renderer (`src/game/surface-rendering/SurfaceRenderer.ts`) currently uses a 3-pass GPU pipeline executed every frame:

1. **Water Height Compute** - Gerstner waves + modifiers → `r32float` screen-sized texture
2. **Terrain Height Compute** - Contour-based terrain → `r32float` screen-sized texture
3. **Surface Composite Fragment** - Samples both textures, computes normals, applies lighting

### Performance Problem

The terrain height pass recomputes terrain at **every pixel, every frame** despite terrain being **static**:
- At 1920×1080 @ 60fps = ~124 million terrain height calculations per second
- The `TerrainHeightShader.ts` runs `computeTerrainHeight()` for each pixel
- This involves signed distance calculations against contour splines

### Existing Infrastructure

**Relevant Files:**
- `src/core/graphics/webgpu/WebGPURenderTarget.ts` - Off-screen rendering with readback
- `src/core/graphics/webgpu/WebGPUTextureManager.ts` - Texture creation and caching
- `src/core/graphics/Camera2d.ts` - Viewport calculation with caching
- `src/core/util/TilePos.ts` - Simple `[x, y]` tile coordinate type
- `src/game/world/terrain/TerrainResources.ts` - Terrain data with version tracking

**Key observations:**
- `TerrainResources` already has `getVersion()` for change detection
- `Camera2d.getWorldViewport()` returns current world-space bounds
- Textures are currently recreated when screen size changes (`ensureTextures()`)

## Desired Changes

Implement a **Virtual Texture Cache** system that:

1. **Caches terrain height in world-space tiles** - Fixed-size tiles in world coordinates (not screen pixels)
2. **Renders tiles on-demand** - Only computes tiles visible in the current viewport
3. **Reuses cached tiles** - Same tile data used regardless of camera zoom/position
4. **Invalidates on terrain change** - Clears cache when `TerrainResources.getVersion()` changes
5. **Supports multiple LOD levels** (optional, phase 2) - Lower-resolution tiles for zoomed-out views

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    SurfaceRenderer                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │             TerrainTileCache (game/)                 │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │          VirtualTextureCache (core/)           │  │   │
│  │  │  - Generic tile management                     │  │   │
│  │  │  - LRU eviction                               │  │   │
│  │  │  - Tile lifecycle (pending/ready/evicted)     │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │  - Terrain-specific rendering                        │   │
│  │  - Viewport → tile requests                          │   │
│  │  - Provides texture atlas to SurfaceRenderer         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Design Decisions

**Tile Size:** 256×256 pixels per tile (configurable)
- World-space tile coverage depends on LOD level
- At LOD 0 (highest detail): ~25.6 world units per tile (0.1 world units/pixel)

**Cache Size:** 64 tiles max (~16MB at r32float)
- LRU eviction when cache is full
- Can be tuned based on memory budget

**Tile Coordinates:** World-aligned grid
- Tile (0, 0) covers world coords (0, 0) to (25.6, 25.6) at LOD 0
- Camera movement selects different tiles, doesn't re-render

**Composite Shader Changes:**
- Instead of sampling from screen-sized terrain texture
- Sample from tile atlas using world→tile UV transform

## Files to Modify

### New Files (Core - Engine)

- `src/core/graphics/VirtualTextureCache.ts` - Generic tile cache management
  - `TileKey` type for tile identification
  - `VirtualTextureCache<TKey>` class with:
    - LRU tile eviction
    - Tile state tracking (pending/ready/evicted)
    - Tile request batching
    - Atlas texture management
    - World-to-atlas UV calculation

- `src/core/graphics/TileAtlas.ts` - GPU texture atlas for cached tiles
  - Fixed-size atlas texture (e.g., 2048×2048 for 64 256×256 tiles)
  - Slot allocation/deallocation
  - Copy tile data to atlas slots

### New Files (Game - Terrain-specific)

- `src/game/surface-rendering/TerrainTileCache.ts` - Terrain-specific tile caching
  - Wraps `VirtualTextureCache`
  - Computes which tiles are needed for current viewport
  - Manages `TerrainTileShader` dispatch for missing tiles
  - Provides atlas + UV params to composite shader

- `src/game/surface-rendering/TerrainTileShader.ts` - Single-tile terrain compute
  - Similar to `TerrainHeightShader.ts` but renders to a fixed-size tile
  - Takes world-space bounds as uniforms
  - Output: tile texture ready for atlas

- `src/game/surface-rendering/TerrainTileUniforms.ts` - Uniforms for tile shader
  - `tileWorldLeft`, `tileWorldTop`, `tileWorldSize`
  - `tilePixelSize` (256)

### Modified Files

- `src/game/surface-rendering/SurfaceRenderer.ts`
  - Add `TerrainTileCache` member
  - In `onRender()`: request tiles instead of running terrain compute pass
  - Pass tile atlas + UV params to composite shader

- `src/game/surface-rendering/SurfaceCompositeShader.ts`
  - Change terrain height sampling from screen texture to atlas lookup
  - Add uniforms for tile atlas UVs / world-to-atlas transform

- `src/game/surface-rendering/SurfaceCompositeUniforms.ts`
  - Add tile atlas parameters (or pass tile info differently)

## Execution Order

### Phase 1: Core Infrastructure (No Dependencies)

These can be done in parallel:

**1a. VirtualTextureCache (core)**
- Create `src/core/graphics/VirtualTextureCache.ts`
- Implement tile key hashing, LRU eviction, state tracking
- Unit testable without GPU

**1b. TileAtlas (core)**
- Create `src/core/graphics/TileAtlas.ts`
- Implement atlas texture creation, slot allocation
- Implement tile copy to atlas

### Phase 2: Game Integration (Depends on Phase 1)

Sequential:

**2a. TerrainTileShader**
- Create `src/game/surface-rendering/TerrainTileShader.ts`
- Extract from `TerrainHeightShader.ts`, parameterize by world bounds
- Create `src/game/surface-rendering/TerrainTileUniforms.ts`

**2b. TerrainTileCache**
- Create `src/game/surface-rendering/TerrainTileCache.ts`
- Use `VirtualTextureCache` + `TileAtlas` + `TerrainTileShader`
- Implement viewport → tile requests logic

**2c. Composite Shader Changes**
- Modify `SurfaceCompositeShader.ts` for atlas sampling
- Modify `SurfaceCompositeUniforms.ts` for atlas parameters

**2d. SurfaceRenderer Integration**
- Modify `SurfaceRenderer.ts` to use `TerrainTileCache`
- Replace terrain compute pass with tile cache lookup

### Phase 3: Optimization (Optional, Depends on Phase 2)

**3a. Multi-LOD Support**
- Add LOD level to tile keys
- Render lower-res tiles for zoomed-out views
- Implement LOD selection based on camera zoom

**3b. Async Tile Rendering**
- Render tiles over multiple frames to avoid hitching
- Show lower-LOD fallback while high-res tile renders

## API Design

### VirtualTextureCache (core)

```typescript
interface TileState {
  status: 'empty' | 'pending' | 'ready';
  lastUsedFrame: number;
  atlasSlot: number | null;
}

interface VirtualTextureCacheConfig {
  tileSize: number;        // pixels per tile (256)
  maxTiles: number;        // max cached tiles (64)
  atlasSize: number;       // atlas texture size (2048)
  format: GPUTextureFormat; // tile format (r32float)
}

class VirtualTextureCache {
  constructor(config: VirtualTextureCacheConfig);

  // Request tiles for current frame (call before rendering)
  requestTiles(tileKeys: string[]): TileRequest[];

  // Mark tiles as rendered (call after compute pass)
  markTilesReady(tileKeys: string[]): void;

  // Get atlas texture view for sampling
  getAtlasView(): GPUTextureView;

  // Get UV offset/scale for a tile
  getTileUV(tileKey: string): { u: number, v: number, size: number } | null;

  // Clear all tiles (call on invalidation)
  clear(): void;

  // Called each frame to update LRU
  advanceFrame(): void;
}

interface TileRequest {
  key: string;
  atlasSlot: number;  // where to render
  // Caller is responsible for actual rendering
}
```

### TerrainTileCache (game)

```typescript
interface VisibleTile {
  key: string;
  worldLeft: number;
  worldTop: number;
  worldSize: number;
  atlasSlot: number;
}

class TerrainTileCache {
  constructor(terrainResources: TerrainResources);

  // Call each frame with current viewport
  // Returns tiles that need rendering
  update(viewport: Viewport): TileRequest[];

  // Render missing tiles (call between update and composite)
  renderTiles(requests: TileRequest[], encoder: GPUCommandEncoder): void;

  // Get atlas for composite shader binding
  getAtlasView(): GPUTextureView;

  // Get list of visible tiles with their atlas UVs
  getVisibleTiles(): VisibleTile[];

  // Check if terrain version changed, clear if so
  checkInvalidation(): boolean;
}
```

## Data Flow (Per Frame)

```
1. SurfaceRenderer.onRender()
   ├── Get current viewport
   ├── TerrainTileCache.checkInvalidation()
   │   └── If terrain version changed: cache.clear()
   ├── TerrainTileCache.update(viewport)
   │   ├── Calculate which tiles intersect viewport
   │   ├── Request tiles from VirtualTextureCache
   │   └── Return list of tiles needing render
   ├── TerrainTileCache.renderTiles(requests)
   │   └── For each tile request:
   │       ├── Create compute pass
   │       ├── Dispatch TerrainTileShader to atlas slot
   │       └── Mark tile ready
   ├── (Water height compute - unchanged)
   └── Composite pass
       ├── Bind tile atlas texture
       ├── For each visible tile:
       │   └── Sample terrain height from atlas using tile UVs
       └── Blend with water, apply lighting
```

## Considerations

### Memory Budget
- 64 tiles × 256×256 × 4 bytes = 16MB for tile atlas
- Plus atlas management overhead
- Configurable based on target hardware

### Tile Boundary Handling
- Option A: 1-pixel overlap between tiles for seamless sampling
- Option B: Clamp sampling at tile edges (may show seams)
- Recommend Option A with 1-pixel border

### Zoom Levels
- Phase 1: Single LOD at fixed world-units-per-pixel
- Tiles may appear pixelated when zoomed in significantly
- Phase 3 adds multi-LOD for quality at all zoom levels

### Cache Coherence
- Moving camera should mostly reuse tiles
- Rapid camera movement may cause cache thrashing
- LRU eviction prioritizes recently-viewed tiles

### Terrain Edits
- `TerrainResources.getVersion()` already tracks changes
- Full cache clear on any terrain edit (simple approach)
- Future: Partial invalidation for local edits
