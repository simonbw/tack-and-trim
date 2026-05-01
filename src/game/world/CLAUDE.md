# World Systems (`src/game/world/`)

World state queries for terrain, water, and wind. Entities sample world
data at arbitrary points each frame; the actual math runs in a pool of
web workers backed by a single compiled WASM kernel.

## Architecture Overview

Each subsystem (terrain, water, wind) follows a three-layer pattern:

| Layer                   | Role                                          | Example             |
| ----------------------- | --------------------------------------------- | ------------------- |
| **Resources** entity    | Owns source data, packs it for the kernel     | `WaterResources`    |
| **QueryManager** entity | Writes per-frame params, distributes results  | `WaterQueryManager` |
| **Query** entity        | Declares sample points, exposes typed results | `WaterQuery`        |

The pipeline:

```
BaseQuery (per-entity sample points + result view)
   ↓
QueryManager (collects points, packs into shared buffer)
   ↓
QueryWorkerCoordinator (one per game; batches all managers per frame)
   ↓
QueryWorkerPool (owns the shared WebAssembly.Memory + workers)
   ↓
N × query-worker.ts (one WASM instance each, work-steals chunks)
```

Game entities create a Query, add it to the game, and read results each
frame. Discovery, dispatch, and result delivery happen automatically.

## Shared-Memory & Workers

The pool allocates one `WebAssembly.Memory({ shared: true })` and
partitions it manually into per-channel regions (points, params, results,
modifiers) plus an immutable tail holding packed world-state buffers
(terrain DFS, wave/tide/wind meshes). Each worker instantiates the
same compiled WASM module against this memory and reads/writes via
integer offsets — no copies between JS and WASM.

A small separate control SAB (Int32Array) drives the per-frame
generation-counter handshake. Workers `Atomics.wait` on the generation
slot, claim chunks of points via `Atomics.add` on a per-descriptor
counter (dynamic work-stealing — fast cores naturally take more chunks
than slow cores), and decrement a `remaining` counter when done; the
last worker out notifies the main thread.

Worker count defaults to `max(hardwareConcurrency - 4, 2)` to leave
cores for the cloth worker pool and compositor; `localStorage`
`queryWorkerCount` overrides it for benchmarking.

## Query Lifecycle

```
afterPhysicsStep:
  Coordinator: each manager writes params + packs points into shared mem
  Coordinator: pool.submit() bumps generation, workers wake up

(Workers run in parallel: claim chunks, call process_*_batch in WASM,
decrement remaining)

next tick:
  Each manager: await pool.awaitFrameComplete(), then distribute
  zero-copy Float32Array views over the results region to its queries
```

Results have **one frame of latency**: points collected in frame N
produce results read in frame N+1. `BaseQuery` holds two point arrays
(`_points` matching current results, `_pendingPoints` submitted for next
frame) and swaps them in `receiveData()` so points and results stay
synchronized.

## Using Queries

```typescript
const waterQuery = this.game.addEntity(
  new WaterQuery(() => [this.body.position]),
);

for (let i = 0; i < waterQuery.length; i++) {
  const result = waterQuery.get(i);
  const height = result.surfaceHeight;
  const vel = result.velocity; // cached V2d, don't store across frames
}

// One-shot
const results = await terrainQuery.getResultAndDestroy();
```

## Zero-Allocation Result Pattern

After warmup the result path allocates nothing:

1. Each pool channel has a `results` Float32Array view directly over
   the shared `WebAssembly.Memory`. Workers write into it in place.
2. Each query gets a zero-copy Float32Array sub-view (`receiveData`).
3. View classes (`WaterResultView`, etc.) cache `V2d` instances —
   getters mutate the cached vector in place and return it.

**Important**: View getters return the same `V2d` object each call.
Don't store references across frames or across `get()` calls.

```typescript
// WRONG — overwritten on the next read
const savedVelocity = waterQuery.get(0).velocity;
waterQuery.get(1);
// RIGHT
const savedVelocity = waterQuery.get(0).velocity.clone();
```

## Adding a New Query Type

Water is the most complete example. Steps:

1. **Result layout + view** (`FooQueryResult.ts`): `ResultLayout` with
   stride and field offsets; view class reading from `_data`.
2. **Query entity** (`FooQuery.ts`): extend `BaseQuery<FooResultView>`,
   set `stride`, implement `get(index)` reusing a cached view array.
3. **QueryManager** (`FooQueryManager.ts`): extend `QueryWorkerManager`,
   set `queryType`, implement `getQueries()` and `writeParamsToSab()`.
4. **WASM entry point**: add a `process_foo_batch` export in
   `pipeline/query-wasm/` and dispatch it from `query-worker.ts`.
5. **Resources** (if needed): singleton entity owning packed world-state
   buffers handed to the pool at level load.

## Subsystem Notes

### Terrain

Defined as a containment tree of closed contour splines, each with a
height value. The kernel traverses the tree using DFS pre-order with
skip counts (outside a contour → entire subtree skipped). Height
between contour levels is blended via inverse distance weighting. All
terrain data is packed into a single `Uint32Array` with a 5-element
header pointing at vertices, contours, children, a 64×64 containment
grid, and per-contour 16×16 IDW candidate-edge grids. CCW winding is
normalized at load.

### Water

Combines Gerstner waves (two-pass: horizontal displacement, then
height at displaced position) with wavefront-mesh terrain interaction
(per-wave energy, direction, phase corrections), a modifier table
(wakes, ripples, currents, obstacles), tidal flow, and simplex-noise
amplitude modulation. Mesh data is packed into a single `Uint32Array`
read via `lookupMeshForWave` with spatial-grid + barycentric lookup.

### Wind

Base wind velocity modulated per-point by simplex noise for speed and
direction. A wind mesh exists in the kernel for per-vertex terrain
influence (speed factor, direction offset, turbulence) but vertices
currently ship as neutral.

## Tricky Bits

- **View getters return `V2d` not `ReadonlyV2d`**: enforcing readonly
  cascades through `FluidVelocityFn` and `CompatibleTuple`. Read-only
  by convention.

- **Per-worker shadow stacks**: each WASM Instance has its own
  `__stack_pointer` global, but the linear memory is shared. The pool
  carves a `STACK_BYTES_PER_WORKER` region per worker and rewrites each
  Instance's stack pointer at init so the stacks don't overlap.

- **tickLayer = "query"**: managers, resources, and the coordinator use
  this layer to ensure ordering relative to other game systems.
