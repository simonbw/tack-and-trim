# World Data Systems

Spatial data computation using GPU with CPU fallback for game physics queries.

## Purpose

Game systems (boat physics, particles, etc.) need to query spatial data like wind velocity, water state, and terrain height at world positions. This directory provides data providers:

**Real-Time Data Providers:**
- **WindInfo** (`wind/`) - Wind direction and speed field with noise-based variation
- **WaterInfo** (`water/`) - Wave height, surface velocity, and currents with wake modifiers
- **TerrainInfo** (`terrain/`) - Land height from procedural island definitions

**Global State:**
- **WeatherState** (`weather/`) - Global atmospheric and oceanic conditions

## Architecture

```
┌─────────────┐    queries    ┌─────────────────┐
│ Game Entity │ ◄───────────► │ WindInfo/       │
│ (Boat, etc) │               │ WaterInfo/      │
└─────────────┘               │ TerrainInfo     │
                              └────────┬────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
        ┌──────────┐            ┌───────────┐            ┌────────────┐
        │ GPU Tile │            │ CPU       │            │ Weather    │
        │ (cached) │            │ Fallback  │            │ State      │
        └──────────┘            └───────────┘            └────────────┘
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
    const wind = this.game!.entities.getSingleton(WindInfo);
    const velocity = wind.getVelocityAtPoint(this.position);
  }
}
```

## Performance Notes

- Tiles are computed per-frame based on query demand (not viewport)
- GPU readback is async to avoid stalls (1-frame latency)
- CPU fallback is consistent but slower - acceptable for rare out-of-view queries
- Each system uses ~64 tiles max per frame (configurable)
