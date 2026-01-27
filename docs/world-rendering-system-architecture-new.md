# World Rendering System Architecture

## Purpose of This Document

This documentation is part of a deliberate refactoring strategy. Over time, the world rendering and data systems accumulated complexity and vestiges of abandoned approaches. Rather than incrementally cleaning up the existing code, we're taking a different approach:

1. **Document thoroughly** - Capture everything the current system does, how it works, and why.
2. **Delete the existing code** - With the system fully documented and the old code safely preserved in git, we can delete the existing implementation entirely.
3. **Design fresh** - Using this documentation as a specification, design a cleaner architecture that incorporates lessons learned but without the accumulated cruft.
4. **Rebuild from scratch** - Implement the new design with consistent patterns and cleaner code.

### Old and New Documents

- `world-rendering-system-architecture-old.md` — describes exactly how the old system works
- `world-rendering-system-architecture-new.md` — describes how we want the new system to work

**THIS IS THE NEW VERSION.** Reference the old document for implementation details of the current system.

---

# Table of Contents

1. [Design Considerations](#design-considerations)
2. [Architecture Overview](#architecture-overview)
3. [Query Infrastructure](#query-infrastructure)
4. [Terrain System](#terrain-system)
5. [Wave System](#wave-system)
6. [Wind System](#wind-system)
7. [Surface Rendering](#surface-rendering)

---

# Design Considerations

These are lessons learned from the old implementation and key decisions for the new system.

## 1. Point-Based Queries Instead of Tiles

**Problem with tiles**: The current tile system has resolution mismatches with camera zoom. When zoomed in, tile resolution is too low and things look blocky. When zoomed out, we compute hundreds of tiles at higher resolution than needed. We also compute data for regions that may never be queried.

**Proposed solution**: Instead of computing rectangular tiles, upload a buffer of specific query points and compute only those. This would:

- Eliminate resolution mismatches entirely
- Never compute data that isn't needed
- Require maintaining a point → buffer-index mapping

**Open question**: How does rendering work? Rendering needs dense 2D data for textures. Options:

- Rendering uses a separate system from gameplay queries
- Rendering requests points on a grid matching its texture resolution
- Some hybrid approach

## 2. Static vs Dynamic Data

The new system should distinguish between:

- **Static data** (terrain): Computed once, cached, invalidated only when modified (for editor or gameplay)
- **Dynamic data** (water, eventually wind): Computed per-frame or on-demand

## 3. Eliminating CPU Fallback Code

**Goal**: If we use point-based queries, we can ensure all needed points are always computed on GPU, eliminating the need for CPU fallback entirely. This is a huge win for maintainability—no more keeping CPU and GPU implementations in sync.

## 4. Wetness System Simplification

The current wetness system is complex (ping-pong textures, snapped viewports, reprojection) and still has artifacts. Open to simpler approaches. Key constraint: wetness is purely visual, no gameplay effect.

## 5. Remove Pre-computed Influence Fields

Decision: Remove the `InfluenceFieldManager` entirely. Wind should be written similarly to the wave system, possibly sharing code. Terrain influence on wind/water should be computed inline, not pre-cached.

## 6. Coordinate Space Conventions

**Problem**: Viewport/rect handling has been error-prone.

**Solution**:

- Use "rect" not "viewport" where appropriate
- Names must indicate coordinate space: `worldRect`, `screenRect`, `textureRect`
- Provide helper functions to translate between spaces
- Most margins should be 1-2 texels, not percentages

## 7. Wave Shadow System

The wave shadow system is working well and should be preserved. Core idea: compute shadow geometry for each island and wave source, use that geometry when determining wave energy at any point.

## 8. Wind System is Placeholder

Current wind is simple simplex noise. Will be redesigned after the water system is solid, using similar patterns and possibly sharing code.

---

# Architecture Overview

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
    │ (static) │    │(dynamic) │    │(dynamic) │
    └──────────┘    └──────────┘    └──────────┘
          │               │               │
          └───────────────┼───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Surface Rendering                          │
│    (Composites world data into final visual output)         │
└─────────────────────────────────────────────────────────────┘
```

## Key Principles

1. **Simulation independent of camera**: Game physics should work the same regardless of where the camera is, or if there's no camera at all.

2. **Query what you need**: Don't compute data speculatively. Entities request the specific points they need.

3. **GPU-first, no CPU fallback**: All world data computation happens on GPU. No duplicate CPU implementations to maintain.

4. **Static data is cached**: Terrain computed once and cached. Dynamic data (waves, wind) computed on-demand.

5. **Rendering is separate**: The visual rendering system consumes world data but has its own concerns (resolution, margins, textures).

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

**TODO**: Detail the WebGPU async readback mechanics — staging buffers, `mapAsync`, double-buffering strategy.

## API Design

### Persistent Queries (Common Case)

Entities create child query objects that persist across frames:

```typescript
class Boat extends BaseEntity {
  constructor() {
    // WaterQuery calls the callback after physics to collect points
    this.waterQuery = this.addChild(
      new WaterQuery(() => {
        return this.hull.vertices.map((v) => this.localToWorld(v));
      }),
    );
  }

  @on("tick")
  onTick() {
    const water = WaterInfo.fromGame(this.game);
    for (const vertex of this.hull.vertices) {
      const worldPos = this.localToWorld(vertex);
      const info = water.getInfoAtPoint(worldPos);
      if (info) {
        // Use water height, velocity, etc. for physics
      }
      // info is null on first frame before any results exist
    }
  }
}
```

The query entity:

- Stores a callback that returns the points to query
- Callback is invoked after physics each frame
- Points are registered with the central query system

### One-Off Queries (Occasional Use)

For cases where you just need data once:

```typescript
// Returns a promise that resolves next frame
const info = await water.getInfoAtPointAsync(position);

// Or with explicit callback
water.getInfoAtPointAsync(position).then((info) => {
  // Do something with the water info
});
```

This is sugar over the persistent query system—it creates a temporary query, waits one frame, returns the result, and cleans up.

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

No deduplication — the mapping from entity to buffer range is direct, with no hashing, string keys, or spatial snapping. This is simpler and avoids the cost of building a deduplication map each frame. The buffer budget (8192) is generous relative to expected usage (low thousands), so duplicate points from overlapping queries waste a few slots but aren't a concern. If buffer pressure becomes real later, deduplication can be added as an optimization.

Minimum meaningful spatial resolution is ~0.01 ft — points closer than that can be considered equivalent for any future deduplication or caching.

## Dependency Ordering

Water and wind computations need terrain data (for depth effects, terrain blocking). This creates a dependency:

```
Terrain queries (no dependencies)
    ↓
Water queries (need terrain depth at each point)
Wind queries (need terrain for blocking)
```

**Implementation approach**:

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
│ (deduplicated)  │      │ (+ implicit     │
│                 │      │  terrain deps)  │
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
- **Release builds**: Log warning, skip excess points

Typical expected usage:

- Boat hull: 20-50 points
- Wake particles: 100-500 points
- Water queries total: hundreds to low thousands per frame

8192 gives plenty of headroom for normal gameplay.

## First-Frame Handling

When an entity is added, it won't have query results until the next frame. API returns `null`, caller decides how to handle:

```typescript
const info = water.getInfoAtPoint(point);
const height = info?.height ?? 0; // Default to sea level
const velocity = info?.velocity ?? V(0, 0); // Default to still water
```

This is explicit—callers know they're handling missing data. If null-handling becomes tedious, we can add convenience methods later.

## Terrain Caching (Special Case)

Terrain queries are dominated by **rendering** (potentially millions of pixels) rather than physics (hundreds of points). This calls for a different approach than water/wind.

**For physics**: Simple point queries, small cache, or just compute on demand. The volume is low enough that this is cheap.

**For rendering**: Virtual texture with LOD—a well-established pattern for large static data:

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

Key properties:

- **LOD selection**: Camera zoom determines which LOD level (coarse when zoomed out, fine when zoomed in)
- **Lazy computation**: Tiles computed on-demand when first visible
- **Fallback chain**: If a tile isn't computed yet, use a coarser LOD that is
- **LRU eviction**: When memory limit hit, evict least-recently-used tiles
- **Invalidation**: Clear cache when terrain is modified (editor, gameplay)

This keeps memory bounded while supporting both zoomed-out overview and zoomed-in detail views.

The `VirtualTexture` abstraction is reused for all large static data:

- `VirtualTexture<TerrainHeight>` - terrain heights
- `VirtualTexture<ShadowData>` - wave shadow intensity (one per wave source, or combined)

Same infrastructure, different compute functions for filling tiles.

### Implementation Details

**Tile size**: 128×128 texels. Small enough for good spatial granularity (only load tiles that are actually visible), large enough to avoid excessive management overhead.

**Tile formats**:
- Terrain height: `r16float` (f16) — 32KB per tile
- Shadow data: `rg8unorm` (2×u8, intensity + distance-to-edge) — 32KB per tile

**Memory budget**: 512 tiles per VirtualTexture instance. At 32KB per tile, that's 16MB per instance — modest GPU memory usage. With one terrain VT and a few shadow VTs (one per wave source), total is well under 100MB.

**LOD levels**: Power-of-2 scheme. Each LOD level doubles the world coverage per texel:

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

**Request flow each frame**:
1. Determine visible world rect from camera
2. Compute LOD from camera zoom
3. Find all tile addresses that overlap the visible rect
4. For each tile: if cached, mark as recently used. If not cached, add to pending queue.
5. Process pending queue (see compute fill below)

**Fallback chain**: If a tile at the requested LOD isn't ready yet, sample from the nearest coarser LOD that is cached. This means zooming in shows blurry data briefly before sharp tiles stream in — acceptable since terrain and shadows are static and tiles compute fast.

**Eviction**: LRU. When a new tile needs a slot and all 512 are occupied, evict the tile with the oldest last-access timestamp. Tiles at coarser LODs could be given eviction priority protection (they're cheap to keep and serve as fallbacks), but this is an optimization to add if needed.

**Compute fill**: One compute dispatch per tile. The dispatch writes a 128×128 output texture given the tile's world-space bounds:
- **Terrain tiles**: For each texel, compute the world position, walk the containment tree, interpolate height. The containment tree and contour data are uploaded as GPU buffers.
- **Shadow tiles**: For each texel, compute the world position, test against shadow polygon geometry (uploaded as a GPU buffer), write intensity and distance-to-edge.

Per-frame cap on tile computations (e.g., 4–8 tiles per frame) to avoid stalling. Tiles stream in progressively. Batching multiple tiles into a single dispatch is a future optimization if dispatch overhead becomes measurable.

## Rendering vs Simulation

These are **separate systems** with different needs:

| Aspect         | Simulation             | Rendering               |
| -------------- | ---------------------- | ----------------------- |
| Access pattern | Sparse specific points | Dense 2D texture        |
| Resolution     | Fixed (physics needs)  | Varies with camera zoom |
| Timing         | 1 frame latency OK     | Must be current frame   |
| Data flow      | Point queries          | Texture-based compute   |

**Design decision**: Rendering uses its own compute pipelines that output to textures (similar to old system but simpler). Simulation uses point queries. They share:

- The underlying compute shader code (same wave math, etc.)
- Terrain data (rendering can sample the terrain cache/texture)
- Configuration (wave parameters, wind settings)

The rendering system is documented in [Surface Rendering](#surface-rendering).

---

# Terrain System

## Overview

Terrain is static data defined by contours (closed Catmull-Rom splines at specific heights). Being static, it's a candidate for aggressive caching, but the full map at high resolution is too large to keep entirely in memory.

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

Terrain uses the same point-based query system as water and wind. No special treatment—water queries that need terrain depth just trigger terrain point queries through the standard dependency mechanism (see Query Infrastructure).

## Rendering

Rendering needs dense terrain data for the visible area (potentially millions of pixels). This uses the `VirtualTexture` abstraction:

- LOD based on camera zoom level
- Lazy tile computation as camera moves
- Fallback to coarser LOD when fine tiles not yet computed
- LRU eviction to bound memory

See [Surface Rendering](#surface-rendering) for how rendering consumes terrain data.

## Invalidation

When terrain is modified (editor or gameplay):

1. Rebuild the containment tree
2. Re-extract coastlines (notify wave shadow system)
3. Clear the virtual texture cache (tiles will recompute on demand)
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

Wave sources are defined per-level in the level file, not as global constants:

```typescript
interface WaveSource {
  direction: number; // Radians, direction waves travel FROM
  baseAmplitude: number; // Base wave height (ft)
  wavelength: number; // Distance between crests (ft)
  // ... other parameters
}
```

- **Shadow geometry** is computed once when level loads (depends on direction)
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

Shadows represent where wave energy is blocked/diffracted by terrain. The system correctly handles concave coastlines (e.g., bays).

### Shadow Geometry (at level load)

1. Extract coastlines (height=0 contours) from terrain
2. For each wave source direction:
   - Find silhouette points: where coastline tangent is parallel to wave direction
   - Identify left/right extremal silhouette points
   - Sample the leeward coastline arc between them
   - Build shadow polygon: silhouette points + coastline arc + extended boundaries

Shadow polygons may be concave (following the actual coastline shape). This geometry is stored for rasterization.

### Shadow Tiles (VirtualTexture)

Shadows are static (like terrain), so we use the same `VirtualTexture` infrastructure:

```typescript
VirtualTexture<ShadowData>; // One per wave source, or combined
```

- **Tiles computed on demand**: When a region is queried, rasterize shadow polygons into that tile
- **Cached**: Shadows don't change during gameplay
- **LOD**: Coarser tiles when zoomed out or for distant queries
- **Invalidated**: When terrain changes (triggers shadow geometry recomputation)

This unifies the approach for terrain and shadows—same infrastructure, different data.

**Decision**: One `VirtualTexture<ShadowData>` per wave source. This keeps each source's shadow data independent, simplifies invalidation (only recompute the source whose geometry changed), and avoids combining semantically different shadow regions into a single texture. The water shader samples each shadow texture separately and combines the results (e.g., multiply shadow intensities).

### Shadow Data

Each shadow texel contains:

- Shadow intensity (0 = full sun, 1 = full shadow)
- Distance to nearest silhouette edge (for diffraction calculations)
- Which shadow polygon (if multiple islands)

Future: soft shadow edges, proper Fresnel diffraction based on distance and obstacle width.

### Diffraction (Future)

Currently shadows have hard edges. Future improvements:

- Soft shadow edges based on distance from silhouette
- Fresnel diffraction model for realistic wave bending around obstacles
- Shadow intensity varying with distance into shadow region

The rasterization approach makes these enhancements easier to implement and iterate on.

## Depth Effects

Water queries need terrain depth (handled by query dependency system).

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

## Water Modifiers (Generalized)

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

### Performance (targeting 10,000+ modifiers)

- **Buffer management**: Persistent GPU buffer sized for max modifiers (e.g., 16k). Upload only active portion each frame.
- **Spatial queries**: If iterating all modifiers is too slow, add spatial hash for fast "modifiers near point" queries.
- **GPU iteration**: Shader iterates through modifier buffer. GPU handles parallel iteration well.

Each effect (wake particle, anchor splash, etc.) is an entity that manages a `WaterModifier`. Modifiers are collected and uploaded before water computation.

**TODO**: Specify the GPU buffer layout for water modifiers and how spatial queries work on the GPU side.

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

Wind uses the same point-based query interface as water, but with a deliberately simple implementation for now. The structure supports future complexity (terrain influence, wind shadows, gusts) without requiring it.

## Query Result

```typescript
interface WindQueryResult {
  vx: number; // Wind velocity X (ft/s)
  vy: number; // Wind velocity Y (ft/s)
}
```

## Current Implementation (Simple)

For this rebuild, wind is just:

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

Same pattern as water:

```typescript
class WindInfo {
  static fromGame(game: Game): WindInfo;

  getWindAtPoint(point: V2d): WindQueryResult | null;
  getWindAtPointAsync(point: V2d): Promise<WindQueryResult>;

  // Level-defined base wind
  getBaseWind(): V2d;
}

// Persistent query (same pattern as WaterQuery)
class WindQuery extends BaseEntity {
  constructor(getPoints: () => V2d[]) { ... }
}
```

## Future Direction

When we're ready to make wind more complex:

- **Terrain influence**: Wind blocked/deflected by terrain (similar to wave shadows)
- **Wind shadows**: `VirtualTexture<WindShadowData>` like wave shadows
- **Gusts**: Temporal variation beyond smooth noise
- **Local modifiers**: Sails affecting nearby wind (like water modifiers)

The query interface stays the same—only the implementation changes. Entities don't need to know whether wind is simple noise or a complex simulation.

---

# Surface Rendering

_TODO: Flesh out rendering design — compute pipeline structure, texture formats, resolution strategy, and compositing details._

## Overview

The visual output pipeline. Composites world data into the final image displayed to the player.

## Key Components

### Water Rendering

- Sample wave heights for normal computation
- Depth-based coloring (shallow → deep gradient)
- Fresnel reflections
- Foam at shoreline
- Specular highlights

### Terrain Rendering

- Height-based coloring or texturing
- Contour visualization (debug mode)

### Wetness Effect

- Visual darkening of sand when wet
- Needs redesign—current ping-pong system is complex
- Purely visual, no gameplay effect

**TODO**: Design a simpler wetness system to replace the current ping-pong approach.

### Compositing

- Fullscreen shader combining all layers
- Lighting model (sun direction, ambient, diffuse, specular)

## Rendering vs Simulation

Rendering has different needs than gameplay simulation:

- Needs dense 2D texture data (not sparse points)
- Cares about camera viewport and zoom level
- Can tolerate lower precision / approximations
- Only needs data that will be visible

**TODO**: Resolve how the rendering system gets dense 2D texture data when the simulation is point-based. This is the core architectural question — options include separate render pipelines, grid-aligned point queries, or a hybrid approach.
