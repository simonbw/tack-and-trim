# Phase 1: Core Infrastructure

**Status**: Not Started
**Start Date**: TBD
**Completion Date**: TBD
**Estimated Duration**: 2-3 days

---

## Goal

Build the foundational VirtualTexture and QueryInfrastructure systems that all other phases depend on. These are generic, reusable systems with no game-specific logic.

---

## Components Checklist

### VirtualTexture System
- [ ] `VirtualTexture.ts` - Generic tile-based caching with LOD
- [ ] `TileCache.ts` - LRU eviction and tile management
- [ ] `TileCompute.ts` - Abstract base class for tile filling

### Query Infrastructure
- [ ] `QueryInfrastructure.ts` - Central coordinator entity
- [ ] `BaseQuery.ts` - Abstract query entity base class

---

## Implementation Tasks

### VirtualTexture&lt;T&gt;
- [ ] Create generic class with type parameter T
- [ ] Implement tile addressing (lod, tileX, tileY) → texture index
- [ ] Create GPU texture array for tile storage
- [ ] Implement `requestTilesForRect()` - tile request batching
- [ ] Implement `getTile()` with fallback chain to coarser LOD
- [ ] Implement `update()` - process pending tile computations
- [ ] Implement `invalidate()` - clear all cached tiles
- [ ] Cap tile computations per frame (4-8 tiles)
- [ ] Export GPU texture array for shader binding

**Key Data Structures**:
```typescript
interface VirtualTextureConfig<T> {
  tileSize: number;           // 128×128
  maxTiles: number;           // 512
  baseWorldUnitsPerTexel: number;
  maxLOD: number;
  tileFormat: GPUTextureFormat;
  computeFn: TileComputeFunction<T>;
}
```

### TileCache
- [ ] Create HashMap for tile lookup: `Map<string, CachedTile>`
- [ ] Implement LRU tracking with frame timestamps
- [ ] Implement `get()` - lookup cached tile
- [ ] Implement `allocate()` with LRU eviction
- [ ] Implement `touch()` - update LRU timestamp
- [ ] Implement `clear()` - remove all tiles

**Key Data Structures**:
```typescript
interface CachedTile<T> {
  lod: number;
  tileX: number;
  tileY: number;
  textureIndex: number;
  lastAccessFrame: number;
  data: T;
}
```

### TileCompute (Abstract)
- [ ] Extend ComputeShader base class
- [ ] Define abstract `getComputeCode()` method
- [ ] Define abstract `getBindings()` method
- [ ] Implement `computeTile()` - dispatch for single tile
- [ ] Calculate workgroup size for 128×128 tiles (8×8 = 64 threads)

**Shader Structure**:
```wgsl
@group(0) @binding(0) var<uniform> tileInfo: vec4f; // worldX, worldY, lod, tileSize
@group(0) @binding(1) var<storage, write, FORMAT> output: texture_storage_2d<FORMAT>;
// Additional bindings defined by subclasses

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // Compute world position from tile + texel
  // Fill tile with computed data
}
```

### QueryInfrastructure
- [ ] Create entity extending BaseEntity
- [ ] Set `id = "queryInfrastructure"` and `tickLayer = "environment"`
- [ ] Create point buffers (fixed size: 8192 points)
- [ ] Create result buffers (terrain, water, wind)
- [ ] Create staging buffers A and B for async readback
- [ ] Implement query registration/unregistration
- [ ] Implement point collection from queries
- [ ] Implement GPU buffer upload
- [ ] Implement compute shader dispatch sequencing
- [ ] Implement double-buffered async readback
- [ ] Implement result distribution to queries
- [ ] Handle buffer overflow gracefully (log warning, skip excess)

**Buffer Flow**:
```typescript
@on("tick")
async onTick(dt: number) {
  // 1. Wait for previous frame's staging buffer
  const stagingBuffer = this.stagingBuffers[this.frameIndex % 2];
  await stagingBuffer.mapAsync(GPUMapMode.READ);

  // 2. Read results
  const results = new Float32Array(stagingBuffer.getMappedRange());
  this.distributeResults(results);
  stagingBuffer.unmap();

  // 3. Collect new query points
  const points = this.collectPoints();

  // 4. Upload to GPU
  device.queue.writeBuffer(this.pointBuffer, 0, points);

  // 5. Dispatch computes
  const encoder = device.createCommandEncoder();
  this.dispatchComputes(encoder);

  // 6. Copy to staging buffer for next frame
  const nextStaging = this.stagingBuffers[(this.frameIndex + 1) % 2];
  encoder.copyBufferToBuffer(this.resultBuffer, 0, nextStaging, 0, resultSize);

  device.queue.submit([encoder.finish()]);

  // 7. Start async map for next frame (non-blocking)
  nextStaging.mapAsync(GPUMapMode.READ);

  this.frameIndex++;
}
```

### BaseQuery (Abstract)
- [ ] Create abstract entity extending BaseEntity
- [ ] Implement constructor with `getPoints: () => V2d[]` callback
- [ ] Create `points: readonly V2d[]` array
- [ ] Create `results: readonly unknown[]` array
- [ ] Implement `getResultForPoint()` with linear scan + V2d.equals()
- [ ] Implement Symbol.iterator for [point, result] pairs
- [ ] Implement `getResultAndDestroy()` Promise helper
- [ ] Implement `getQueryPoints()` - internal for infrastructure
- [ ] Implement `setResults()` - internal for infrastructure
- [ ] Add `bufferOffset` and `bufferCount` fields

**Public API**:
```typescript
abstract class BaseQuery extends BaseEntity {
  readonly points: readonly V2d[];
  readonly results: readonly unknown[];

  getResultForPoint(point: V2d): unknown | undefined;
  [Symbol.iterator](): Iterator<[V2d, unknown]>;
  getResultAndDestroy(): Promise<this>;
}
```

---

## Testing Checklist

### VirtualTexture Tests
- [ ] Create mock TileCompute with test pattern (gradient)
- [ ] Test tile request at LOD 0
- [ ] Test tile request at multiple LODs
- [ ] Verify fallback to coarser LOD when tile not ready
- [ ] Test LRU eviction when cache fills (allocate 513 tiles)
- [ ] Test invalidation clears all tiles
- [ ] Verify tile-per-frame cap works (queue doesn't grow unbounded)

### QueryInfrastructure Tests
- [ ] Create mock query with simple test points
- [ ] Verify double-buffered readback works
- [ ] Test first frame behavior (results array empty)
- [ ] Test second frame (results populated)
- [ ] Test buffer overflow (8193 points) - logs warning, doesn't crash
- [ ] Verify frame-to-frame latency (results lag by one frame)
- [ ] Test multiple queries sharing infrastructure

### BaseQuery Tests
- [ ] Test `getResultForPoint()` finds matching point
- [ ] Test `getResultForPoint()` returns undefined for missing point
- [ ] Test iterator returns all [point, result] pairs
- [ ] Test `getResultAndDestroy()` resolves and destroys entity

---

## Debug Visualization

- [ ] Create debug entity to visualize VirtualTexture tile boundaries
- [ ] Create debug entity to render query points as dots
- [ ] Add toggle for showing/hiding debug overlays
- [ ] Display tile LOD levels with color coding

---

## WGSL Shaders

### Query Point Buffer Layout
```wgsl
struct QueryPoint {
  x: f32,
  y: f32,
}

@group(0) @binding(0) var<storage, read> points: array<QueryPoint>;
@group(0) @binding(1) var<storage, read_write> results: array<Result>;
```

---

## Files Created

```
src/game/world/virtual-texture/
  ├── VirtualTexture.ts          [ ] ~300 lines
  ├── TileCache.ts               [ ] ~150 lines
  └── TileCompute.ts             [ ] ~100 lines

src/game/world/query/
  ├── QueryInfrastructure.ts     [ ] ~400 lines
  └── BaseQuery.ts               [ ] ~200 lines

tests/world/
  ├── VirtualTexture.test.ts     [ ]
  └── QueryInfrastructure.test.ts [ ]
```

**Total Lines**: ~1150 + tests

---

## Demo Milestone

Create a test scene that:
- [ ] Loads a VirtualTexture with test tile compute
- [ ] Visualizes tile boundaries on screen
- [ ] Shows tiles streaming in as camera moves
- [ ] Creates a query entity with interactive points (follow mouse)
- [ ] Displays query results next to query points
- [ ] Shows one-frame latency in action

---

## Blockers & Dependencies

### Prerequisites
- [ ] ComputeShader base class exists and works
- [ ] GPU device management working
- [ ] Test framework set up

### Blockers
- None (this is the foundation)

---

## Notes & Decisions

### Key Technical Decisions
- **Tile size**: 128×128 texels (good balance of granularity vs overhead)
- **Max tiles**: 512 (16MB per VT instance)
- **Buffer size**: 8192 points (generous for expected usage)
- **Staging buffers**: Double-buffered to overlap CPU/GPU work
- **Tile computation cap**: 4-8 tiles per frame

### Future Optimizations
- Batch multiple tile computations into single dispatch
- Spatial hashing for query point deduplication
- Adaptive buffer sizing based on usage
- GPU timestamp profiling for all compute passes

---

## Completion Criteria

Phase 1 is complete when:
- [ ] All components implemented and pass tests
- [ ] Demo scene working and demonstrates features
- [ ] No GPU errors or validation warnings
- [ ] Performance profiled (tile compute < 1ms each)
- [ ] Code reviewed and documented
- [ ] Ready to start Phase 2
