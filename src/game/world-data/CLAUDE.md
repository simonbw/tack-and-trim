# World Data Systems

Spatial data computation using GPU with CPU fallback for game physics queries.

## Purpose

Game systems (boat physics, particles, etc.) need to query spatial data like wind velocity, water state, and terrain height at world positions. This directory provides data providers and pre-computed influence fields:

**Real-Time Data Providers:**
- **WindInfo** (`wind/`) - Wind direction and speed field with noise-based variation
- **WaterInfo** (`water/`) - Wave height, surface velocity, and currents with wake modifiers
- **TerrainInfo** (`terrain/`) - Land height from procedural island definitions

**Pre-Computed at Startup:**
- **InfluenceFieldManager** (`influence/`) - Terrain effects on wind and waves
- **WeatherState** (`weather/`) - Global atmospheric and oceanic conditions

## Architecture

```
┌─────────────┐    queries    ┌─────────────────┐
│ Game Entity │ ◄───────────► │ WindInfo/       │
│ (Boat, etc) │               │ WaterInfo/      │
└─────────────┘               │ TerrainInfo     │
                              └────────┬────────┘
                                       │
         ┌─────────────────┬───────────┼───────────┬─────────────────┐
         ▼                 ▼           ▼           ▼                 ▼
   ┌───────────┐    ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌────────────┐
   │ Influence │    │ GPU Tile │  │ GPU Tile  │  │ CPU       │  │ Weather    │
   │ Fields    │    │ (cached) │  │ (compute) │  │ Fallback  │  │ State      │
   └───────────┘    └──────────┘  └───────────┘  └───────────┘  └────────────┘
```

### Query Forecasting

Entities that query data implement a `*Querier` interface and use a tag:

- `windQuerier` tag + `WindQuerier` interface → `getWindQueryForecast()`
- `waterQuerier` tag + `WaterQuerier` interface → `getWaterQueryForecast()`
- `terrainQuerier` tag + `TerrainQuerier` interface → `getTerrainQueryForecast()`

Forecasts provide an AABB and expected query count. The data tile system uses this to prioritize which tiles to compute.

### Data Tile Pipeline (`datatiles/`)

The core abstraction shared by all three systems:

- **DataTileManager** - Tracks tile grid, scores tiles based on query forecasts
- **DataTileComputePipeline** - Entity that orchestrates GPU compute and async readback
- **DataTileReadbackBuffer** - Handles GPU→CPU data transfer with viewport mapping

Each tile covers a world-space region and is rendered to a GPU texture. The texture is read back asynchronously for CPU-side queries.

### GPU/CPU Hybrid

1. **GPU path** (fast): Query hits a cached tile with valid data
2. **CPU fallback** (slower): Query is outside computed tiles, computed on demand

The CPU fallback uses the same algorithms but without GPU parallelism. This ensures consistent results regardless of camera position.

### Influence Field System (`influence/`)

Pre-computed fields that capture how terrain affects wind and waves. Computed once at game startup, then sampled at runtime.

**Three Field Types:**
- **Wind Influence** - How terrain blocks and deflects wind (speedFactor, directionOffset, turbulence)
- **Swell Influence** - How terrain affects wave propagation via diffraction (attenuation factors per wavelength class)
- **Fetch Map** - Distance wind can blow over open water (affects local wave development)

**Key Components:**
- **InfluenceFieldManager** (`InfluenceFieldManager.ts`) - Orchestrates async startup computation, provides sampling API, holds grids directly
- **InfluenceFieldGrid** (`InfluenceFieldGrid.ts`) - 3D grid storing data per (x, y, direction), uses trilinear interpolation
- **propagation/** - Algorithms that ray-march from terrain to compute influence values

**Async Initialization:**
```typescript
// Listen for completion
@on("influenceFieldsReady")
onInfluenceFieldsReady() {
  // Safe to add visual entities that depend on influence data
}

// Or await directly
const manager = InfluenceFieldManager.fromGame(game);
await manager.waitForInitialization();
```

**Sampling:**
```typescript
const manager = InfluenceFieldManager.fromGame(game);
const windInfluence = manager.sampleWindInfluence(x, y, windDirection);
const swellInfluence = manager.sampleSwellInfluence(x, y, swellDirection);
const fetch = manager.sampleFetch(x, y, windDirection);
```

### Weather System (`weather/`)

Global atmospheric and oceanic conditions that drive the wind/wave system:

- **WeatherState** - Combines wind, swell, and tide parameters
- Provides defaults for typical sailing conditions
- Changes slowly over time (minutes to hours of game time)

## Key Files

| File | Purpose |
|------|---------|
| **Data Providers** | |
| `wind/WindInfo.ts` | Wind data provider, base wind + noise variation |
| `water/WaterInfo.ts` | Water state provider, waves + wakes + currents |
| `terrain/TerrainInfo.ts` | Terrain height provider, procedural islands |
| **Data Tile System** | |
| `datatiles/DataTileComputePipeline.ts` | Generic tile computation orchestration |
| `datatiles/DataTileManager.ts` | Tile scoring and selection |
| `*/webgpu/*Compute.ts` | Domain-specific GPU compute shaders |
| `*/cpu/*ComputeCPU.ts` | CPU fallback implementations |
| **Influence Field System** | |
| `influence/InfluenceFieldManager.ts` | Async startup computation, sampling API |
| `influence/InfluenceFieldGrid.ts` | 3D grid with trilinear interpolation |
| `influence/PropagationConfig.ts` | Resolution and algorithm parameters |
| `influence/propagation/*.ts` | Propagation algorithms (ray-marching) |
| **Weather** | |
| `weather/WeatherState.ts` | Global weather state types and defaults |

## Adding a Querier

To make an entity query one of these systems:

```typescript
class MyEntity extends BaseEntity {
  tags = ["windQuerier"]; // Register for forecasting

  getWindQueryForecast(): QueryForecast | null {
    return {
      aabb: { minX: ..., maxX: ..., minY: ..., maxY: ... },
      queryCount: 10, // Expected queries this frame
    };
  }

  @on("tick")
  onTick() {
    const wind = WindInfo.fromGame(this.game!);
    const velocity = wind.getVelocityAtPoint(this.position);
  }
}
```

## Performance Notes

- Tiles are computed per-frame based on query demand (not viewport)
- GPU readback is async to avoid stalls (1-frame latency)
- CPU fallback is consistent but slower - acceptable for rare out-of-view queries
- Each system uses ~64 tiles max per frame (configurable)
