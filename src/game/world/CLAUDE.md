# World Systems (`src/game/world/`)

GPU-accelerated world state queries for terrain, water, and wind. Entities sample world data at arbitrary points each frame via WebGPU compute shaders with asynchronous readback.

## Architecture Overview

Each subsystem (terrain, water, wind) follows a three-layer pattern:

| Layer | Role | Example |
|-------|------|---------|
| **Resources** entity | Owns GPU buffers, uploads data | `WaterResources` |
| **QueryManager** entity | Runs GPU compute pipeline, delivers results | `WaterQueryManager` |
| **Query** entity | Declares sample points, exposes typed results | `WaterQuery` |

Game entities create a Query, add it to the game, and read results each frame. Everything else is automatic -- query discovery, GPU dispatch, and result delivery happen without manual registration.

## Query Lifecycle

```
Frame N:
  QueryManager.onTick()
    1. Await mapAsync from frame N-1
    2. Copy mapped GPU data to persistent CPU buffer
    3. Unmap GPU buffer immediately
    4. Distribute result slices to queries via receiveData()

  (Entities read query results here)

  Physics step runs

  QueryManager.onAfterPhysicsStep()
    1. Collect points from all queries (positions post-physics)
    2. Upload points to GPU
    3. Dispatch compute shader + copy to readback buffer (single command)
    4. Swap double buffers, start mapAsync for next frame
```

Results have **one frame of latency**. Points collected in frame N produce results available in frame N+1. This is acceptable because positions don't change drastically between adjacent frames.

## Using Queries

```typescript
// Create a query with a point-supplier callback
const waterQuery = this.game.addEntity(
  new WaterQuery(() => [this.body.position])
);

// Read results (available after one frame)
// Hot path: use get(i) + length
for (let i = 0; i < waterQuery.length; i++) {
  const result = waterQuery.get(i);
  const height = result.surfaceHeight;
  const vel = result.velocity; // cached V2d, don't store across frames
}

// One-shot query
const results = await terrainQuery.getResultAndDestroy();
```

## Zero-Allocation Result Pattern

This is the key performance optimization. After warmup, the entire result path allocates nothing.

1. `QueryManager` maintains a persistent `dataBuffer: Float32Array` on the CPU
2. GPU results are copied into this buffer each frame
3. Each query gets a **zero-copy Float32Array view** into the manager's buffer via `receiveData()`
4. View classes (`WaterResultView`, etc.) cache `V2d` instances -- getters mutate and return the cached instance

**Important**: View getters return the same `V2d` object each call, mutated in place. Callers must **not** store references to returned vectors across frames or across different `get()` calls, because the underlying data will change.

```typescript
// WRONG - velocity will be overwritten when you read the next result
const savedVelocity = waterQuery.get(0).velocity;
waterQuery.get(1); // savedVelocity now points at stale/wrong data

// RIGHT - copy if you need to keep the value
const savedVelocity = waterQuery.get(0).velocity.clone();
```

## Double-Buffered GPU Readback

WebGPU buffers can't be read while the GPU is writing to them. The double-buffer pattern solves this:

- Frame N: GPU writes results to readback buffer A. `mapAsync` starts on A.
- Frame N+1: GPU writes to readback buffer B. CPU reads A, unmaps it.
- Frame N+2: GPU writes to A again. CPU reads B.

The CPU copies mapped data to a persistent `dataBuffer` and unmaps **immediately** -- the readback buffer must be unmapped before `copyBufferToBuffer` can write to it next frame.

## Adding a New Query Type

Follow the existing pattern (water is the most complete example):

1. **Result layout + view** (`FooQueryResult.ts`):
   - Define a `ResultLayout` with stride and field offsets
   - Create a view class with getters reading from `_data` at `_offset + field`
   - Cache any `V2d` instances in private fields

2. **Query entity** (`FooQuery.ts`):
   - Extend `BaseQuery<FooResultView>`, set `stride`, tag, and implement `get(index)`
   - Cache view instances in a `views[]` array for zero-allocation reuse

3. **QueryManager entity** (`FooQueryManager.ts`):
   - Extend `QueryManager`, implement `getQueries()` and `dispatchCompute()`
   - Set `tickLayer = "query" as const`

4. **Compute shader** (`FooQueryShader.ts`):
   - Use the shader module system (see `shaders/README.md`)

5. **Resources entity** (if needed) (`FooResources.ts`):
   - Singleton entity owning GPU buffers for source data
   - Set `tickLayer = "query" as const` if it updates per-tick

## Shader Module System

Shared WGSL code lives in `shaders/` as TypeScript objects with dependency tracking. See `shaders/README.md` for full documentation.

Key points:
- One export per module, prefixed: `fn_` (functions), `struct_` (structs), `const_` (constants)
- Dependencies are explicit arrays -- `ComputeShader` resolves, deduplicates, and concatenates
- TypeScript constants are interpolated into WGSL via template literals (`${MAX_WAVES}`) so CPU and GPU share values

## Subsystem Details

### Terrain

Terrain is defined as a **containment tree** of closed contour splines, each with a height value. The GPU shader traverses this tree using **DFS pre-order with skip counts** -- if a point is outside a contour, its entire subtree is skipped (O(depth) instead of O(N)). Height between contour levels is smoothly blended via **inverse distance weighting (IDW)**.

All terrain GPU data is packed into a single `array<u32>` buffer (`packedTerrainBuffer`) with a 3-element header `[verticesOffset, contoursOffset, childrenOffset]` followed by the data sections. Accessor functions in `shaders/terrain-packed.wgsl.ts` (`getTerrainVertex`, `getContourData`, `getTerrainChild`) read from this buffer using `bitcast<f32>()` for float fields. The contour section uses mixed u32/f32 data -- writing integer fields through a Float32Array would produce wrong bit patterns, so packing uses `DataView` / `Uint32Array` with careful handling. All contours are normalized to CCW winding on load.

### Water

The most complex subsystem. The compute shader combines:
- **Gerstner waves** (two-pass: horizontal displacement, then height at displaced position)
- **Shadow attenuation** behind land masses (Fresnel diffraction model)
- **Wave-terrain interaction** (shoaling via Green's Law + shallow damping)
- **Water modifiers** (wakes, ripples, currents, obstacles) collected from tagged entities each tick
- **Finite-difference normals** (3 height samples)
- **Amplitude modulation** via simplex noise for natural variation

Waves are classified as "swell" or "chop" and receive separate energy modifications from shadows and terrain. Shadow polygon data is packed into a single `array<u32>` buffer (`packedShadowBuffer`) with a header `[waveDir.x, waveDir.y, polygonCount, verticesOffset, ...]` followed by polygon metadata then vertex data. Accessor functions in `shaders/shadow-packed.wgsl.ts` (`getShadowWaveDirection`, `getShadowPolygon`, `isInsideShadowPolygon`) read from this buffer. `WaterResources` also computes tide height from `TimeOfDay` (semi-diurnal cosine, +/-2ft).

### Wind

The simplest subsystem. Base wind velocity is modulated per-point by simplex noise for both speed variation and direction variation. Terrain influence uniforms exist but are currently neutral (hardcoded to no effect in the query manager).

## Tricky Bits

- **View getters return `V2d` not `ReadonlyV2d`**. `ReadonlyV2d` would cascade through `FluidVelocityFn` and `CompatibleTuple` types. The views are read-only by convention, not enforced by the type system.

- **Points and results are double-buffered separately**. `BaseQuery` keeps `_points` (matching current results) and `_pendingPoints` (submitted for next frame). They swap in `receiveData()` so points and results always stay in sync despite the one-frame latency.

- **Partial buffer mapping**. `mapAsync` is called with explicit byte ranges to avoid a WebGPU slow path triggered by large buffer maps (~125KB threshold).

- **Packed storage buffers**. Terrain and shadow data each use a single `array<u32>` buffer instead of multiple typed buffers. This reduces the per-shader storage buffer count (the water query shader went from 10 to 5 bindings), eliminating the need for a `maxStorageBuffersPerShaderStage` device limit override. Accessor functions in `terrain-packed.wgsl.ts` and `shadow-packed.wgsl.ts` handle reading via `bitcast<f32>()`.

- **Placeholder packed shadow buffer**. `WaterQueryManager` creates an empty packed shadow buffer (with `polygonCount = 0` and `verticesOffset = 8`) if `WavePhysicsResources` isn't present, so the shader always has valid bindings even without wave physics.

- **tickLayer = "query"**. All managers and resources in this system use this tick layer to ensure correct ordering relative to other game systems.
