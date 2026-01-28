# World Rendering System Architecture

This document describes the architecture for the world rendering and simulation data systems: how terrain, water, and wind data are computed, queried, and rendered.

---

# Table of Contents

1. [Overview & Principles](#overview--principles)
2. [Architecture Overview](#architecture-overview)
3. [Virtual Texture System](#virtual-texture-system)
4. [Terrain System](#terrain-system)
5. [Wave System](#wave-system)
6. [Wind System](#wind-system)
7. [Query Infrastructure](#query-infrastructure)
8. [Surface Rendering](#surface-rendering)

---

# Overview & Principles

## GPU-First, No CPU Fallback

All world data computation happens on the GPU. There are no duplicate CPU implementations to maintain. The query infrastructure ensures all needed points are always computed on GPU, and results are read back asynchronously.

## Simulation Independent of Camera

Game physics works the same regardless of where the camera is, or whether there's a camera at all. Entities request specific world data points through the query system; the camera only drives the rendering path.

## Static vs Dynamic Data

- **Static data** (terrain, wave shadows): Computed once, cached via the VirtualTexture system, invalidated only when modified.
- **Dynamic data** (water, wind): Computed per-frame or on-demand.

## Query What You Need

Entities submit only the specific points they need. No speculative computation of large grids at potentially wrong resolutions.

## Rendering is Separate

The visual rendering system runs its own dense 2D compute pipelines. It shares shader math and GPU data with simulation but has independent execution. See [Surface Rendering](#surface-rendering).

## Coordinate Space Conventions

- Use "rect" not "viewport" where appropriate.
- Names indicate coordinate space: `worldRect`, `screenRect`, `textureRect`.
- Helper functions translate between spaces.
- Margins are expressed in texels (1–2), not percentages.

---

# Architecture Overview

The system has two parallel execution paths that share data but differ in how they access it.

## Simulation Path

```
┌─────────────────────────────────────────────────────────────┐
│                      Game Entities                          │
│              (Boat, Particles, Camera, etc.)                │
└─────────────────────────┬───────────────────────────────────┘
                          │ query points
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Query Infrastructure                       │
│         (Point-based GPU compute + async readback)          │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Terrain  │    │  Waves   │    │   Wind   │
    │  Query   │    │  Query   │    │  Query   │
    │ Compute  │    │ Compute  │    │ Compute  │
    └────┬─────┘    └────┬─────┘    └────┬─────┘
         │               │               │
         └───────────────┼───────────────┘
                         ▼
              Async readback to CPU
                         │
                         ▼
                Entity physics tick
```

## Rendering Path

```
┌─────────────────────────────────────────────────────────────┐
│                        Camera                               │
│             (visible rect + zoom level)                     │
└─────────────────────────┬───────────────────────────────────┘
                          │ render rect
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                   Surface Rendering                          │
│         (Dense 2D texture compute pipelines)                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Pass 1: Terrain ──→ terrainTexture                         │
│              │                                               │
│              ▼                                               │
│  Pass 2: Water ────→ waterTexture                           │
│              │                                               │
│              ▼                                               │
│  Pass 3: Wetness ──→ wetnessTexture (ping-pong)            │
│              │                                               │
│              ▼                                               │
│  Pass 4: Composite → screen output                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Shared Resources

Both paths read from the same GPU resources — no data is duplicated:

```
                    ┌─────────────────────┐
                    │  Shared GPU Data    │
                    ├─────────────────────┤
                    │ Terrain VT tiles    │
                    │ Shadow VT tiles     │
                    │ Wave source params  │
                    │ Water modifier buf  │
                    │ Time / globals      │
                    └──────┬──────┬───────┘
                           │      │
              ┌────────────┘      └────────────┐
              ▼                                 ▼
     Simulation Path                    Rendering Path
  (point queries → readback)      (dense textures → screen)
```

## Simulation vs Rendering

**What they share:**
- **Shader math**: Wave evaluation (Gerstner), depth effects (shoaling, damping), shadow sampling, modifier accumulation — same WGSL functions used by both paths. The water a boat feels must match the water the player sees.
- **GPU resources**: Terrain VirtualTexture tiles, shadow VirtualTexture tiles, wave source parameters, water modifier buffer, time/globals uniform. Single source of truth, bound read-only by both paths.
- **Configuration**: Level-defined wave sources, wind parameters, terrain data. Loaded once, consumed by both.

**Where they differ:**

| | Simulation | Rendering |
|---|---|---|
| **Trigger** | Entities register query points | Camera determines visible rect |
| **Input geometry** | Sparse points (hundreds–thousands) | Dense 2D grid (screen resolution) |
| **Output** | Storage buffer → async readback to CPU | Textures → composite to screen |
| **Timing** | One frame latency (async readback) | Same frame (GPU only, no readback) |
| **Camera dependency** | None — works without a camera | Entirely camera-driven |
| **Cross-frame state** | None | Wetness ping-pong textures |
| **Exclusive resources** | Query point/result buffers, staging buffers | Render textures (terrain, water, wetness) |

## GPU Resource Ownership

Each GPU resource has a single owner responsible for creating, uploading, and (if applicable) invalidating it. Consumers bind the resource read-only.

| Resource                                 | Owner                 | Upload Frequency                         | Consumers                                      |
| ---------------------------------------- | --------------------- | ---------------------------------------- | ---------------------------------------------- |
| Terrain contour data                     | Terrain system        | Once at load (re-upload on edit)         | Terrain tile compute                           |
| Terrain VirtualTexture tiles             | Terrain system        | On demand, cached (invalidate on edit)   | Water compute, wind compute, surface rendering |
| Shadow geometry (per source)             | Wave shadow system    | Once at load (recompute on terrain edit) | Shadow tile compute                            |
| Shadow VirtualTexture tiles (per source) | Wave shadow system    | On demand, cached (invalidate on edit)   | Water compute, surface rendering               |
| Wave source parameters                   | Wave system           | Once at load                             | Water compute, surface rendering               |
| Query point buffer                       | Query infrastructure  | Every frame                              | Terrain compute, water compute, wind compute   |
| Query result buffers                     | Query infrastructure  | Written by compute each frame            | Entities (via async readback)                  |
| Water modifier buffer                    | Water modifier system | Every frame (active portion only)        | Water compute, surface rendering               |
| Time / globals uniform                   | Game                  | Every frame                              | All compute and render shaders                 |

Key points:

- **Terrain and shadow tiles** are the main shared resources. Both simulation (water/wind compute) and rendering sample them. Single source of truth, no duplication.
- **Wave source parameters** are uploaded once and bound by both water compute (for simulation) and surface rendering (for visual wave evaluation). Same buffer, two bind groups.
- **Query point/result buffers** are only used by the simulation path, not rendering. Rendering uses its own texture-based compute (see [Surface Rendering](#surface-rendering)).

---

# Virtual Texture System

Large static datasets (terrain heights, wave shadow intensity) are too big to keep entirely in memory at full resolution. The VirtualTexture system provides LOD-aware, demand-driven caching for this data.

## Interface

```typescript
interface VirtualTexture<T> {
  // Request tiles for a world rect at a given detail level
  requestTilesForRect(worldRect: Rect, worldUnitsPerPixel: number): void;

  // Get tile data (falls back to coarser LOD if exact tile not ready)
  getTile(worldX: number, worldY: number, lod: number): TileData<T> | null;

  // Process pending tile computations
  update(): void;

  // Invalidate all tiles (when terrain modified)
  invalidate(): void;
}
```

## Instances

The `VirtualTexture` abstraction is reused for all large static data:

- `VirtualTexture<TerrainHeight>` — terrain heights
- `VirtualTexture<ShadowData>` — wave shadow intensity (one per wave source)

Same infrastructure, different compute functions for filling tiles.

One `VirtualTexture<ShadowData>` per wave source keeps each source's shadow data independent, simplifies invalidation (only recompute the source whose geometry changed), and avoids combining semantically different shadow regions into a single texture. The water shader samples each shadow texture separately and combines the results (e.g., multiply shadow intensities).

## Tile Specifications

**Tile size**: 128×128 texels. Small enough for good spatial granularity (only load tiles that are actually visible), large enough to avoid excessive management overhead.

**Tile formats**:
- Terrain height: `r16float` (f16) — 32KB per tile
- Shadow data: `rg8unorm` (2×u8, intensity + distance-to-edge) — 32KB per tile

**Memory budget**: 512 tiles per VirtualTexture instance. At 32KB per tile, that's 16MB per instance — modest GPU memory usage. With one terrain VT and a few shadow VTs (one per wave source), total is well under 100MB.

## LOD

Power-of-2 scheme. Each LOD level doubles the world coverage per texel:

| LOD | World units per texel | Tile covers (world) |
|-----|-----------------------|---------------------|
| 0   | 0.5 ft               | 64×64 ft            |
| 1   | 1.0 ft               | 128×128 ft          |
| 2   | 2.0 ft               | 256×256 ft          |
| 3   | 4.0 ft               | 512×512 ft          |
| ... | ...                   | ...                 |

**LOD selection**: Pick the LOD where one texel ≈ one screen pixel:
```
lod = floor(log2(worldUnitsPerScreenPixel / baseWorldUnitsPerTexel))
```
Clamp to [0, maxLOD]. This ensures we never compute at higher resolution than the screen can show.

**Tile addressing**: Tiles are addressed by (lod, tileX, tileY) where:
```
tileX = floor(worldX / tileWorldSize(lod))
tileY = floor(worldY / tileWorldSize(lod))
```

## Request Flow (Per Frame)

1. Determine visible world rect from camera
2. Compute LOD from camera zoom
3. Find all tile addresses that overlap the visible rect
4. For each tile: if cached, mark as recently used. If not cached, add to pending queue.
5. Process pending queue (see compute fill below)

## Fallback Chain

If a tile at the requested LOD isn't ready yet, sample from the nearest coarser LOD that is cached. This means zooming in shows blurry data briefly before sharp tiles stream in — acceptable since terrain and shadows are static and tiles compute fast.

## Eviction

LRU. When a new tile needs a slot and all 512 are occupied, evict the tile with the oldest last-access timestamp. Tiles at coarser LODs could be given eviction priority protection (they're cheap to keep and serve as fallbacks), but this is an optimization to add if needed.

## Compute Fill

One compute dispatch per tile. The dispatch writes a 128×128 output texture given the tile's world-space bounds:
- **Terrain tiles**: For each texel, compute the world position, walk the containment tree, interpolate height. The containment tree and contour data are uploaded as GPU buffers.
- **Shadow tiles**: For each texel, compute the world position, test against shadow polygon geometry (uploaded as a GPU buffer), write intensity and distance-to-edge.

Per-frame cap on tile computations (e.g., 4–8 tiles per frame) to avoid stalling. Tiles stream in progressively. Batching multiple tiles into a single dispatch is a future optimization if dispatch overhead becomes measurable.

## Error Handling

TODO: Document failure modes and recovery strategies:
- What if tile compute dispatch fails?
- What if we run out of tile memory (all 512 slots occupied)?
- What if texture allocation fails?
- What if device is lost during compute?
- Should we retry failed tiles or mark them as permanently failed?

---

# Terrain System

## Overview

Terrain is static data defined by contours (closed Catmull-Rom splines at specific heights). Being static, it uses the VirtualTexture system for efficient caching and LOD.

## Data Definition

### Contours

Terrain is defined by closed contour loops at specific heights:

```typescript
interface TerrainContour {
  controlPoints: readonly V2d[]; // Catmull-Rom spline control points
  height: number; // Height of this contour (ft)
}

interface TerrainDefinition {
  contours: TerrainContour[];
  defaultDepth: number; // Deep ocean baseline (e.g., -50 ft)
}
```

### Containment Tree

Contours form a hierarchy based on which contains which:

```
Ocean (default depth)
├─ Island A (height=0, coastline)
│  └─ Hill (height=10)
│     └─ Peak (height=20)
└─ Island B (height=0, coastline)
```

The tree is built once when terrain is loaded/modified, then used for height queries.

### Height Computation

Given a point, find its height:

1. Find the deepest (most nested) contour containing the point
2. Use inverse-distance weighting between that contour and its children
3. Result is interpolated height at that point

### Coastline Extraction

Contours with `height=0` are coastlines. These are passed to the wave shadow system for diffraction calculations.

## Physics Queries

Terrain uses the same point-based query system as water and wind. Water queries that need terrain depth trigger terrain point queries through the standard dependency mechanism (see [Query Infrastructure](#query-infrastructure)).

## Rendering

Rendering needs dense terrain data for the visible area (potentially millions of pixels). This uses the VirtualTexture system:

- LOD based on camera zoom level
- Lazy tile computation as camera moves
- Fallback to coarser LOD when fine tiles not yet computed
- LRU eviction to bound memory

See [Surface Rendering](#surface-rendering) for how the rendering pipeline consumes terrain data.

## Invalidation

When terrain is modified (editor or gameplay):

1. Rebuild the containment tree
2. Re-extract coastlines (notify wave shadow system)
3. Clear the virtual texture cache (tiles recompute on demand)
4. Clear any physics query cache

---

# Wave System

## Overview

Dynamic water simulation using Gerstner waves with shadow-based diffraction around terrain.

## Query Result

```typescript
interface WaterQueryResult {
  z: number; // Surface elevation relative to sea level (ft)
  vx: number; // Surface velocity X (ft/s)
  vy: number; // Surface velocity Y (ft/s)
  vz: number; // Surface velocity Z, i.e., dz/dt (ft/s)
}
```

## Wave Sources (Level-Defined)

Wave sources are defined per-level in the level file:

```typescript
interface WaveSource {
  direction: number; // Radians, direction waves travel FROM
  baseAmplitude: number; // Base wave height (ft)
  wavelength: number; // Distance between crests (ft)
  // ... other parameters
}
```

- **Shadow geometry** is computed once when the level loads (depends on direction)
- **Amplitude/intensity** can modulate at runtime without recomputing shadows
- Multiple wave sources per level (e.g., swell + chop with different directions)

## Wave Mathematics

Two-pass Gerstner wave computation:

1. **Displacement pass**: Compute horizontal displacement at the query point
2. **Height pass**: Evaluate wave height at the displaced position (creates trochoid surface)

For each wave source:

```
phase = dot(waveDirection, position) * k - omega * time
height += amplitude * sin(phase)
vz += -amplitude * omega * cos(phase)
```

Where `k = 2π/wavelength` and `omega = sqrt(g * k)` (deep water dispersion).

## Shadow System

Shadows represent where wave energy is blocked/diffracted by terrain. The system handles concave coastlines (e.g., bays).

### Shadow Geometry (at Level Load)

1. Extract coastlines (height=0 contours) from terrain
2. For each wave source direction:
   - Find silhouette points: where coastline tangent is parallel to wave direction
   - Identify left/right extremal silhouette points
   - Sample the leeward coastline arc between them
   - Build shadow polygon: silhouette points + coastline arc + extended boundaries

Shadow polygons may be concave (following the actual coastline shape). This geometry is stored for rasterization.

### Shadow Tiles (VirtualTexture)

Shadows are static, so they use the VirtualTexture system (one instance per wave source):

```typescript
VirtualTexture<ShadowData>; // One per wave source
```

- **Tiles computed on demand**: When a region is queried, rasterize shadow polygons into that tile
- **Cached**: Shadows don't change during gameplay
- **LOD**: Coarser tiles when zoomed out or for distant queries
- **Invalidated**: When terrain changes (triggers shadow geometry recomputation)

### Shadow Data

Each shadow texel contains:

- Shadow intensity (0 = full sun, 1 = full shadow)
- Distance to nearest silhouette edge (for diffraction calculations)
- Which shadow polygon (if multiple islands)

### Diffraction (Future)

Soft shadow edges based on distance from silhouette, Fresnel diffraction model for realistic wave bending around obstacles, shadow intensity varying with distance into shadow region. The rasterization approach makes these enhancements straightforward to add.

## Depth Effects

Water queries need terrain depth (handled by the query dependency system).

### Shoaling (Green's Law)

Waves grow taller as depth decreases:

```
shoalingFactor = (referenceDepth / actualDepth)^0.25
```

### Damping (Bottom Friction)

Waves attenuate in shallow water:

```
if depth > deepThreshold: damping = 1.0
if depth < shallowThreshold: damping = minDamping
else: linear interpolation
```

Combined: `depthModifier = shoalingFactor * dampingFactor`

## Water Modifiers

A unified system for local water disturbances (wakes, splashes, ripples).

### WaterModifier Interface

```typescript
interface WaterModifier {
  // Bounds for fast spatial queries
  getBounds(): AABB;

  // Data for GPU upload
  getModifierData(): WaterModifierData;
}

type WaterModifierData =
  | { type: "segment"; p1: V2d; p2: V2d; amplitude: number; falloff: number }
  | { type: "point"; center: V2d; radius: number; amplitude: number }
  | {
      type: "ring";
      center: V2d;
      radius: number;
      width: number;
      amplitude: number;
    };
```

### Modifier Types

- **Segment**: Wake particles (line between two points)
- **Point**: Splash impact, localized disturbance
- **Ring**: Expanding ripple (radius increases over time)

### Performance (Targeting 10,000+ Modifiers)

- **Buffer management**: Persistent GPU buffer sized for max modifiers (e.g., 16k). Upload only active portion each frame.
- **Spatial queries**: If iterating all modifiers is too slow, add spatial hash for fast "modifiers near point" queries.
- **GPU iteration**: Shader iterates through modifier buffer. GPU handles parallel iteration well.

Each effect (wake particle, anchor splash, etc.) is an entity that manages a `WaterModifier`. Modifiers are collected and uploaded before water computation.

### GPU Buffer Layout

Modifiers are stored in a storage buffer as a flat array of fixed-size structs. Each struct is 32 bytes (8 × f32), using a union layout with a type field:

```wgsl
struct WaterModifier {
  modifierType: f32,  // 0 = inactive/padding, 1 = segment, 2 = point, 3 = ring, ...
  // Bounding box for early culling (world space)
  boundsMinX: f32,
  boundsMinY: f32,
  boundsMaxX: f32,
  boundsMaxY: f32,
  // Type-specific data (meaning depends on modifierType)
  param0: f32,
  param1: f32,
  param2: f32,
}
```

Type-specific field usage:

| Field  | Segment                  | Point     | Ring      |
|--------|--------------------------|-----------|-----------|
| param0 | amplitude                | amplitude | amplitude |
| param1 | falloff                  | radius    | radius    |
| param2 | (unused)                 | (unused)  | width     |

Segment geometry (p1, p2) is encoded in the bounds fields directly — `boundsMin` = p1, `boundsMax` = p2 — since the segment endpoints define the bounds. Point and ring use center = bounds center.

New modifier types can be added by assigning a new `modifierType` value and defining what `param0`–`param2` mean. If a future type needs more than 3 parameters, the struct can be extended (add `param3`–`param5`, bump to 48 bytes).

### Buffer Management

```typescript
const MAX_MODIFIERS = 16384;
const MODIFIER_STRIDE = 32; // bytes

// Persistent GPU buffer, created once
const modifierBuffer = device.createBuffer({
  size: MAX_MODIFIERS * MODIFIER_STRIDE,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

// Each frame: collect active modifiers, write to CPU array, upload active portion
const activeCount = collectModifiers(cpuArray);
device.queue.writeBuffer(modifierBuffer, 0, cpuArray, 0, activeCount * MODIFIER_STRIDE);
```

The active count is passed as a uniform so the shader knows where to stop iterating.

### Shader Iteration with Bounds Culling

The shader iterates all active modifiers but skips early if the texel is outside the modifier's bounding box:

```wgsl
for (var i = 0u; i < activeModifierCount; i++) {
  let mod = modifiers[i];
  // Bounds culling — skip if this texel is outside the modifier's AABB
  if (worldPos.x < mod.boundsMinX || worldPos.x > mod.boundsMaxX ||
      worldPos.y < mod.boundsMinY || worldPos.y > mod.boundsMaxY) {
    continue;
  }
  // Evaluate modifier contribution based on type
  switch (u32(mod.modifierType)) {
    case 1u: { /* segment */ }
    case 2u: { /* point */ }
    case 3u: { /* ring */ }
    default: {}
  }
}
```

This is O(N) iteration with a cheap per-modifier early-out. A spatial hash or grid can be added later if GPU iteration becomes measurably slow.

## Tide

Tide is a pure function of time, constant across space:

```typescript
function getTideHeight(timeOfDay: number): number {
  // Sinusoidal based on time, or more complex tidal model
  return tideRange * sin(timeOfDay * tidalFrequency);
}
```

Added to final water height after all other computations.

---

# Wind System

## Overview

Wind uses the same point-based query interface as water, with a simple implementation that supports future complexity (terrain influence, wind shadows, gusts) without requiring it.

## Query Result

```typescript
interface WindQueryResult {
  vx: number; // Wind velocity X (ft/s)
  vy: number; // Wind velocity Y (ft/s)
}
```

## Implementation

Wind is base wind plus spatially-varying noise:

```
wind(point, time) = baseWind + noise(point, time)
```

Where:

- `baseWind`: Constant vector defined in level file (direction + speed)
- `noise`: Scrolling 2D simplex noise for natural variation

```typescript
function computeWind(point: V2d, time: number, baseWind: V2d): WindQueryResult {
  const noiseScale = 0.01; // Spatial frequency
  const timeScale = 0.1; // How fast noise scrolls
  const variation = 0.2; // ±20% variation

  const nx = noise2D(
    point.x * noiseScale,
    point.y * noiseScale + time * timeScale,
  );
  const ny = noise2D(
    point.x * noiseScale + 100,
    point.y * noiseScale + time * timeScale,
  );

  return {
    vx: baseWind.x * (1 + nx * variation),
    vy: baseWind.y * (1 + ny * variation),
  };
}
```

No terrain influence, no wind shadows, no gusts. Just smooth natural variation.

## API

```typescript
class WindQuery extends BaseEntity {
  constructor(getPoints: () => V2d[]);

  // Results from last frame's GPU compute. Empty until first compute completes.
  readonly results: readonly WindQueryResult[];

  // Resolve with first results, then auto-destroy. For one-off lookups.
  getResultAndDestroy(): Promise<readonly WindQueryResult[]>;
}
```

Base wind (the level-defined constant, before spatial noise) is available immediately from `WorldManager.getBaseWind()`.

See [world-system-api.md](world-system-api.md) for full API details and usage examples.

## Future Direction

When wind needs more complexity:

- **Terrain influence**: Wind blocked/deflected by terrain (similar to wave shadows)
- **Wind shadows**: `VirtualTexture<WindShadowData>` like wave shadows
- **Gusts**: Temporal variation beyond smooth noise
- **Local modifiers**: Sails affecting nearby wind (like water modifiers)

The query interface stays the same — only the implementation changes. Entities don't need to know whether wind is simple noise or a complex simulation.

---

# Query Infrastructure

## Core Concept

Entities that need world data submit query points. The system collects all points, computes them on GPU, and provides results with one frame of latency.

**Frame timeline**:

```
Frame N:
  1. Physics tick - entities use results from Frame N-1
  2. After physics - collect query points for Frame N+1
  3. Upload points to GPU
  4. Run compute shaders (terrain first, then water/wind)
  5. Initiate async readback

Frame N+1:
  1. Complete readback from Frame N
  2. Physics tick - entities use results from Frame N
  ...
```

## Async Readback Mechanics

WebGPU doesn't allow mapping a storage buffer directly. Results must be copied to a staging buffer first, then mapped for CPU read.

**Buffers involved** (per query type — terrain, water, wind):

| Buffer | Usage | Purpose |
|--------|-------|---------|
| Compute buffer | `STORAGE \| COPY_SRC` | Written by compute shader |
| Staging buffer A | `MAP_READ \| COPY_DST` | Mapped by CPU on even frames |
| Staging buffer B | `MAP_READ \| COPY_DST` | Mapped by CPU on odd frames |

Two staging buffers (double-buffered) so the GPU can copy into one while the CPU reads the other.

**Per-frame flow**:

```
Frame N:
  1. Await stagingBuffer[N % 2].mapAsync()      ← block until ready
  2. Read results from mapped buffer             ← CPU reads Frame N-1 results
  3. Unmap stagingBuffer[N % 2]
  4. Physics tick — entities use Frame N-1 results
  5. Collect query points for next frame
  6. Upload points to compute buffer
  7. Dispatch compute shaders
  8. copyBufferToBuffer(computeBuffer → stagingBuffer[N % 2])
  9. Submit command buffer                        ← GPU starts working
  10. Call stagingBuffer[N % 2].mapAsync()         ← non-blocking, resolves when GPU done
```

Steps 1–3 use the staging buffer that was submitted last frame. Steps 8–10 set up the other staging buffer for next frame's readback.

**Blocking behavior**: Step 1 blocks the frame if the GPU hasn't finished the previous frame's compute. In practice this shouldn't happen — the GPU has a full frame to complete the work. If it does block, it means the GPU is behind, and blocking is the correct behavior (we need those results for physics).

**First frame**: No previous results exist. Staging buffers are initialized to zeros. Entities get zeroed results (sea level, no velocity) — safe defaults. After one frame, real results are available.

**Buffer sizing**: Staging buffers are sized to match the compute buffer (8192 points × result struct size). Reallocated if the buffer limit changes.

## API

### Usage

Query objects are child entities that register points and hold results directly. There are no separate Info classes — the query object is both the registration and the result container.

```typescript
class Boat extends BaseEntity {
  private waterQuery: WaterQuery;

  constructor() {
    super();
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.hull.vertices.map((v) => this.localToWorld(v))),
    );
  }

  @on("tick")
  onTick() {
    const results = this.waterQuery.results;
    if (results.length === 0) return; // first frame, no data yet

    for (let i = 0; i < this.hull.vertices.length; i++) {
      const water = results[i];
      // Use water.z, water.vx, water.vy, water.vz for physics
    }
  }
}
```

The query entity:

- Stores a callback that returns the points to query
- Callback is invoked after physics each frame
- Points are registered with the central query system
- Results are stored on the query object, indexed 1:1 with the points from last frame

### One-Off Queries

For cases where you just need data once, use `getResultAndDestroy()`. This waits for the first result, resolves the promise, and auto-destroys the query entity:

```typescript
this.addChild(new WaterQuery(() => [spawnPosition]))
  .getResultAndDestroy()
  .then((results) => {
    const waterHeight = results[0].z;
  });
```

No special system-level codepath — the query infrastructure only ever deals with query entity instances.

See [world-system-api.md](world-system-api.md) for full API details.

## Point → Result Mapping

Each query entity owns a contiguous range of buffer indices, assigned when points are collected each frame:

```typescript
// During point collection, each query gets a contiguous slice
const startIndex = nextFreeIndex;
const points = query.getPoints();
for (let i = 0; i < points.length; i++) {
  pointBuffer[startIndex + i] = points[i];
}
query.bufferOffset = startIndex;
query.bufferCount = points.length;
nextFreeIndex += points.length;

// Reading results is a direct index lookup
const result = resultBuffer[query.bufferOffset + localIndex];
```

No deduplication — the mapping from entity to buffer range is direct, with no hashing, string keys, or spatial snapping. The buffer budget (8192) is generous relative to expected usage (low thousands), so duplicate points from overlapping queries waste a few slots but aren't a concern. Deduplication can be added as an optimization if buffer pressure becomes real.

Minimum meaningful spatial resolution is ~0.01 ft — points closer than that can be considered equivalent for any future deduplication or caching.

## Dependency Ordering

Water and wind computations need terrain data (for depth effects, terrain blocking):

```
Terrain queries (no dependencies)
    ↓
Water queries (need terrain depth at each point)
Wind queries (need terrain for blocking)
```

**Implementation**:

1. When a water query point is registered, automatically register a terrain query at the same location
2. Compute terrain first → results go to terrain buffer
3. Water compute shader receives:
   - The water query points
   - The terrain result buffer
   - A mapping from water point index → terrain buffer index
4. Water shader samples terrain depth from the buffer, uses it for shoaling/damping

```
┌─────────────────────────────────────────────────┐
│           Query Point Collection                 │
│  (after physics, before GPU submission)         │
└─────────────────────┬───────────────────────────┘
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
┌─────────────────┐      ┌─────────────────┐
│ Terrain Points  │      │  Water Points   │
│ (contiguous     │      │ (+ implicit     │
│  ranges)        │      │  terrain deps)  │
└────────┬────────┘      └────────┬────────┘
         │                        │
         ▼                        │
┌─────────────────┐               │
│ Terrain Compute │               │
│ (runs first)    │               │
└────────┬────────┘               │
         │                        │
         │ terrain results        │
         │        ┌───────────────┘
         ▼        ▼
┌─────────────────────┐
│   Water Compute     │
│ (samples terrain    │
│  results buffer)    │
└─────────────────────┘
```

## Buffer Sizing

Fixed-size buffer for query points, with graceful handling if exceeded:

- **Initial limit**: 8192 points (tune based on profiling)
- **Debug builds**: Assert if exceeded, so we notice and investigate
- **Release builds**: Log warning with entity ID, skip excess points (FIFO - first registered entities get their points, later entities are truncated)

Typical expected usage:

- Boat hull: 20-50 points
- Wake particles: 100-500 points
- Water queries total: hundreds to low thousands per frame

8192 gives plenty of headroom for normal gameplay.

**Buffer overflow handling**: When total requested points exceeds the buffer limit, log a warning identifying which entity's points were truncated:
```typescript
console.warn(`Query buffer overflow: ${totalPoints} points requested, limit ${MAX_POINTS}. Excess points from entity '${entity.id}' skipped.`);
```

This makes it clear which system is contributing to buffer pressure and needs optimization or budget increase.

## First-Frame and Late-Join Handling

On the first frame, no compute has run yet. Staging buffers are initialized to zeros, so entities receive zeroed results (sea level, no velocity) — safe defaults. After that first frame, blocking readback guarantees results are always available.

When an entity is added mid-game, its query points won't be in the compute buffer until the next frame. The query's `results` array is empty until the first readback completes. Query entities provide a `hasResults()` helper to make this check cleaner:

```typescript
if (!this.waterQuery.hasResults()) return; // First frame — skip or use defaults
```

After one frame, the entity's points are in the system and results are always available.

## Error Handling

TODO: Document failure modes and recovery strategies:
- What if GPU compute dispatch fails?
- What if async readback times out or fails?
- What if WebGPU device is lost during readback?
- Should queries fall back to CPU computation (violates GPU-first principle) or return stale/default data?
- How do we communicate errors back to query entities?
- Should the system auto-recover by retrying failed dispatches?

---

# Surface Rendering

## Overview

The visual output pipeline. Composites world data into the final image displayed to the player.

Rendering runs its own GPU compute pipelines that write dense 2D textures covering the visible area. It shares the same shader math, input data, and configuration as the simulation path, but never goes through the point query system.

## Render Rect

Each frame, rendering determines the **render rect** — the world-space rectangle to render:

```
renderRect = camera.visibleWorldRect expanded by margin
```

The margin (a few texels worth of world space) ensures screen-edge effects like normals and foam have data to sample from.

**Resolution**: Target roughly 1 texel per screen pixel. The render texture size is:
```
textureWidth = ceil(renderRect.width / worldUnitsPerTexel)
textureHeight = ceil(renderRect.height / worldUnitsPerTexel)
```

Where `worldUnitsPerTexel ≈ renderRect.width / screenWidth`. Textures are recreated when the screen resizes, not every frame.

## Compute Pipeline

The render pipeline runs these passes in order each frame:

```
1. Terrain Pass    → terrainTexture (height, material)
2. Water Pass      → waterTexture (height, normal, foam)
3. Wetness Pass    → wetnessTexture (ping-pong update)
4. Composite Pass  → final screen output
```

### Pass 1: Terrain

Samples terrain VirtualTexture tiles into a screen-sized terrain texture.

- **Input**: Terrain VirtualTexture (cached tiles), render rect
- **Output**: `rg16float` texture — R = terrain height, G = material/terrain type
- **Operation**: For each texel, compute world position from render rect, sample the appropriate VirtualTexture tile at the current LOD. If the exact LOD tile isn't cached yet, fall back to a coarser tile.

This pass is cheap since it's just sampling cached data, not recomputing terrain.

### Pass 2: Water

Evaluates the full water simulation for every visible texel.

- **Input**: Wave source parameters, terrain texture (from pass 1), shadow VirtualTextures, water modifier buffer, time uniform, render rect
- **Output**: `rgba16float` texture — R = water height, GBA = surface normal (or G = height, B = foam, with normals computed from finite differences in the composite pass)
- **Operation**: For each texel:
  1. Compute world position from render rect
  2. Sample terrain height from terrain texture → derive water depth
  3. Sample shadow intensity from shadow VirtualTexture tiles (one per wave source)
  4. For each wave source: evaluate Gerstner displacement + height, apply depth effects (shoaling, damping), apply shadow attenuation
  5. Iterate water modifiers (wakes, splashes, ripples) and accumulate their contributions
  6. Write final water height and surface data

This is the most expensive pass since it evaluates wave math per-texel per-source, plus iterates modifiers.

### Pass 3: Wetness (Ping-Pong)

Updates the wetness state using two alternating textures.

- **Input**: Previous wetness texture (read), terrain texture, water texture, render rect, previous render rect, dt
- **Output**: Current wetness texture (write)
- **Format**: `r8unorm` — single channel, 0 = dry, 1 = fully wet

**Operation** for each texel:
1. Compute world position from current render rect
2. Compute UV in previous wetness texture by mapping world position → previous render rect
3. If UV is within [0,1] bounds: sample previous wetness value
4. If UV is out of bounds (new screen area): previous wetness = 0 (dry)
5. Read terrain height and water height at this texel
6. If terrain is underwater (terrain height < water height): set wetness = 1.0
7. If terrain is above water: decay previous wetness toward 0 (`wetness -= decayRate * dt`)
8. Write result to current wetness texture

**Ping-pong**: Two wetness textures alternate roles each frame. Frame N reads texture A, writes texture B. Frame N+1 reads texture B, writes texture A. This avoids read-write hazards.

**Key design decisions**:
- **New pixels default to dry.** When the viewport moves or zooms, texels that map outside the previous texture simply start at 0. No reprojection, no gap-filling. If the terrain is being hit by waves, it'll be wet within one wave cycle.
- **All render passes share the same render rect.** The water texture must cover at least the same world rect as the wetness texture. Using the same render rect for all passes prevents sampling outside valid regions.
- **Decay rate** can vary — sand barely above waterline could stay wet longer than higher terrain. A simple approach: `decayRate = baseRate * clamp(terrainHeight - waterHeight, 0, maxHeight) / maxHeight`.

### Pass 4: Composite

Fragment shader that combines all data into the final image.

- **Input**: Terrain texture, water texture, wetness texture, lighting uniforms
- **Output**: Screen pixels

**Operation** for each pixel:
1. Sample terrain → determine base color (sand, grass, rock based on height/material)
2. Apply wetness darkening (multiply base color by `1 - wetness * darkeningFactor`)
3. Sample water data → compute surface normal (from finite differences if not stored directly), determine water color from depth
4. Apply lighting model:
   - Ambient light
   - Diffuse shading from sun direction × surface normal
   - Specular highlights (sun reflection on water)
   - Fresnel-based water opacity (shallow water more transparent)
5. Blend water over terrain based on depth (shallow water shows terrain through)
6. Add foam at shoreline (where depth is near zero, or from water texture foam channel)

## Texture Lifecycle

Render textures are **not** cached across frames (unlike VirtualTexture tiles). They are:
- Allocated once at a size matching the screen resolution
- Reallocated when window resizes
- Written fresh each frame (terrain, water) or updated in-place (wetness ping-pong)

The only cross-frame state is the wetness ping-pong pair.

**Implementation note**: The ping-pong texture pattern can use the existing `DoubleBuffer<GPUTexture>` utility from `src/core/util/DoubleBuffer.ts`:
```typescript
const wetnessTextures = new DoubleBuffer(textureA, textureB);

// Each frame
wetnessPass.render({
  input: wetnessTextures.getRead(),
  output: wetnessTextures.getWrite(),
});
wetnessTextures.swap();
```

## Error Handling

TODO: Document failure modes and recovery strategies:
- What if render texture allocation fails (out of GPU memory)?
- What if compute pass dispatch fails?
- What if screen resize happens mid-frame?
- Should we fall back to lower resolution if allocation fails?
- How do we handle device lost during rendering?
