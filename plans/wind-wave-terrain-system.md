# Wind & Wave Terrain System Implementation Plan

## Overview

Implement a terrain-aware wind and wave system where:
- Wind is blocked, accelerated, and deflected by terrain
- Waves are blocked, diffracted, and shoaled by terrain
- Wave amplitude varies based on fetch (distance to upwind land)
- Different locations have distinct character based on geography

**Design Documents:**
- [Physics Reference](../docs/wind-wave-physics.md)
- [System Design](../docs/wind-wave-system-design.md)

---

## Progress Tracking

**Current Status:** Phase 0 complete

**Last Updated:** 2026-01-20

**Next Step:** Phase 1 - Terrain sampling

### Phase Completion Checklist

| Phase | Status | Commit Point | Description |
|-------|--------|--------------|-------------|
| Phase 0 | [x] | `feat: add wind-wave foundation types` | Types, grid, config |
| Phase 1 | [ ] | `feat: add terrain sampler for propagation` | TerrainSampler + helpers |
| Phase 2 | [ ] | `feat: add propagation algorithms` | Wind, swell, fetch propagation |
| Phase 3 | [ ] | `feat: add influence field storage` | Field classes with sampling |
| Phase 4 | [ ] | `feat: add influence field manager` | Manager + startup integration |
| Phase 5 | [ ] | `feat: terrain-aware wind system` | Wind uses influence fields |
| Phase 6 | [ ] | `feat: terrain-aware wave system` | Waves use influence + fetch |
| Phase 7 | [ ] | `feat: tune wind-wave parameters` | Polish and optimization |
| Phase 8 | [ ] | `feat: weather evolution` | Optional - dynamic weather |
| Phase 9 | [ ] | `feat: terrain-aware currents` | Optional - current field |

---

## How to Resume Work

When resuming this plan:

1. **Check current status** in the Progress Tracking section above
2. **Read the checkpoint notes** for the last completed phase
3. **Verify the system state** matches the checkpoint description
4. **Continue from the next incomplete phase**

Each phase ends with a working, committable state. You should be able to:
- Run the game without errors after each phase
- See incremental progress (even if not all features work yet)
- Safely commit and push

---

## Current State

### Wind System (`src/game/world-data/wind/`)

**Architecture:**
- `WindInfo` entity manages wind queries (hybrid GPU/CPU)
- `WindTileCompute` + `WindStateShader` compute per-tile wind using simplex noise
- Base wind is a constant `V2d` (e.g., `V(11, 11)` ft/s)
- Variation comes from simplex noise (±50% speed, ±10° angle)
- `WindModifier` interface allows sails to affect local wind

**Key Files:**
- `WindInfo.ts` (319 lines) - Query routing, base wind control
- `WindConstants.ts` (76 lines) - Noise parameters, scales
- `webgpu/WindTileCompute.ts` (144 lines) - GPU tile orchestration
- `webgpu/WindStateShader.ts` (126 lines) - WGSL compute shader
- `cpu/WindComputeCPU.ts` (79 lines) - CPU fallback

**Limitation:** No terrain awareness. Wind is the same everywhere regardless of geography.

### Water/Wave System (`src/game/world-data/water/`)

**Architecture:**
- `WaterInfo` entity manages water queries (hybrid GPU/CPU)
- `WaterDataTileCompute` + `WaterStateShader` compute Gerstner waves + wake modifiers
- 12 hardcoded wave components in `WaterConstants.ts`
- Wave sources are global - same waves everywhere
- `WaterModifier` interface allows wakes to affect local water

**Key Files:**
- `WaterInfo.ts` (~300 lines) - Query routing, current calculation
- `WaterConstants.ts` (~200 lines) - 12 wave components, Gerstner params
- `webgpu/WaterDataTileCompute.ts` - GPU tile orchestration
- `webgpu/WaterStateShader.ts` - WGSL Gerstner + modifiers
- `webgpu/WaterComputeBuffers.ts` - GPU buffers for wave data
- `cpu/WaterComputeCPU.ts` - CPU fallback

**Limitation:** No terrain awareness. Waves don't know about land, fetch, or depth.

### Terrain System (`src/game/world-data/terrain/`)

**Architecture:**
- Landmasses defined as Catmull-Rom splines (`LandMass` interface)
- `TerrainInfo` computes signed distance + height from splines
- GPU + CPU implementations for height queries
- Tile-based caching via `DataTileComputePipeline`

**Key Files:**
- `TerrainInfo.ts` - Query provider, landmass management
- `LandMass.ts` - Landmass definition interface
- `TerrainConstants.ts` - Tile config, spline params
- `webgpu/TerrainStateShader.ts` - GPU height computation
- `cpu/TerrainComputeCPU.ts` - CPU fallback

**Available Data:**
- `getLandMasses()` returns all landmass definitions
- `getHeightAtPoint(V2d)` returns terrain height (positive = land, negative = underwater)
- Control points define coastline boundaries

### Tile Pipeline (`src/game/world-data/datatiles/`)

**Architecture:**
- `DataTileComputePipeline<TSample, TCompute>` - Generic orchestrator
- `DataTileManager` - Tile scoring based on query forecasts
- `DataTileReadbackBuffer` - Async GPU→CPU transfer
- All three systems (wind, water, terrain) use this infrastructure

**Configuration:**
- All use 64 ft tile size
- Wind: 256px resolution, Water/Terrain: 128px resolution
- Max 64 tiles computed per frame

---

## Desired Changes

### New Components

1. **Weather State** - Global conditions that drive the system
   - Wind direction, speed, gust factor
   - Swell direction, amplitude, period
   - Tide phase and range

2. **Pre-computed Influence Fields** - Computed once at startup
   - Wind influence field (per direction): speed factor, direction offset, turbulence
   - Swell influence field (per direction, per wavelength class): energy factor, arrival direction
   - Fetch map (per direction): distance to open water
   - Current field: base flow patterns, tidal influence

3. **Enhanced Tile Computation** - Modified wind/water tile shaders
   - Sample influence fields
   - Combine with weather state
   - Apply local modifiers (shoaling, damping)

4. **Derived Wave Parameters** - Replace hardcoded wave sources
   - Swell components from weather + influence field
   - Wind-wave components from local wind + fetch

### System Behavior

**Wind near terrain:**
- Blocked in lee of islands (wind shadow)
- Accelerated through narrow channels
- Turbulent in wake of obstacles

**Waves near terrain:**
- Blocked by land (no direct waves)
- Diffracted around obstacles and through inlets
- Shoaled in shallow water (amplitude increases)
- Damped near shore

**Spatial variation:**
- Open ocean: full wind, full developed waves
- Lee of island: reduced wind, diffracted waves from sides
- Bay interior: light wind, gentle diffracted swell, minimal wind-waves
- Narrow channel: accelerated wind, rough chop

---

## Files to Modify

### New Files to Create

#### Core Types and State

```
src/game/world-data/weather/
├── WeatherState.ts              # Weather state interface and defaults
├── WeatherController.ts         # Entity managing weather evolution (optional)
```

#### Influence Field System

```
src/game/world-data/influence/
├── InfluenceFieldTypes.ts       # Shared types for all influence fields
├── InfluenceFieldGrid.ts        # Generic coarse grid data structure
├── PropagationConfig.ts         # Tuning parameters for propagation
│
├── WindInfluenceField.ts        # Wind propagation result storage
├── WindInfluencePropagation.ts  # Wind propagation algorithm
│
├── SwellInfluenceField.ts       # Swell propagation result storage
├── SwellInfluencePropagation.ts # Swell propagation algorithm (more diffraction)
│
├── FetchMap.ts                  # Fetch distance computation and storage
├── FetchMapComputation.ts       # Ray-marching fetch algorithm
│
├── CurrentField.ts              # Base current patterns (optional, phase 2)
│
└── InfluenceFieldManager.ts     # Orchestrates all field computation at startup
```

#### Propagation Helpers

```
src/game/world-data/influence/propagation/
├── TerrainSampler.ts            # Efficient terrain boundary queries for propagation
├── PropagationGrid.ts           # Grid iteration utilities
└── PropagationMath.ts           # Shared math (direction blending, decay)
```

### Files to Modify

#### Wind System

**`src/game/world-data/wind/WindInfo.ts`**
- Add dependency on `InfluenceFieldManager`
- Add dependency on `WeatherState`
- Modify `getVelocityAtPoint()` to sample influence field
- Add method to get weather-modified wind for a tile
- Keep existing modifier system intact

**`src/game/world-data/wind/WindConstants.ts`**
- Add constants for influence field resolution
- Add constants for propagation parameters
- Keep existing noise constants (still used for gusts)

**`src/game/world-data/wind/webgpu/WindStateShader.ts`**
- Add uniform for local wind influence (speed factor, direction offset, turbulence)
- Modify computation to apply influence to base wind
- Keep noise-based gust variation

**`src/game/world-data/wind/webgpu/WindTileCompute.ts`**
- Accept wind influence parameters per tile
- Pass to shader via params buffer

**`src/game/world-data/wind/cpu/WindComputeCPU.ts`**
- Add influence field sampling
- Match GPU computation

#### Water System

**`src/game/world-data/water/WaterInfo.ts`**
- Add dependency on `InfluenceFieldManager`
- Add dependency on `WeatherState`
- Add dependency on `TerrainInfo` (for depth/shoaling)
- Replace hardcoded wave sources with derived parameters
- Modify `getStateAtPoint()` to use terrain-aware wave params

**`src/game/world-data/water/WaterConstants.ts`**
- Remove hardcoded `WAVE_COMPONENTS` array (or keep as fallback)
- Add constants for wave derivation (fetch relationship, shoaling)
- Add constants for swell/wind-wave component generation

**`src/game/world-data/water/webgpu/WaterStateShader.ts`**
- Modify to accept variable wave parameters per tile
- Add shoaling factor input
- Add damping factor input
- Keep wake modifier system intact

**`src/game/world-data/water/webgpu/WaterDataTileCompute.ts`**
- Accept derived wave parameters per tile
- Accept shoaling/damping factors
- Pass to shader via buffers

**`src/game/world-data/water/webgpu/WaterComputeBuffers.ts`**
- Modify wave data buffer to be per-tile (not global)
- Or add separate buffer for tile-specific wave params

**`src/game/world-data/water/cpu/WaterComputeCPU.ts`**
- Accept variable wave parameters
- Match GPU computation

#### Terrain System

**`src/game/world-data/terrain/TerrainInfo.ts`**
- Add method `getShoreDistance(point: V2d): number`
- Add method `getDepthAtPoint(point: V2d): number` (may already exist via height)
- Ensure `getLandMasses()` is efficient for propagation queries

**`src/game/world-data/terrain/LandMass.ts`**
- No changes needed (control points already accessible)

#### Integration Points

**`src/game/GameController.ts` (or equivalent startup)**
- Initialize `InfluenceFieldManager` at game start
- Trigger propagation computation after terrain is defined
- Create `WeatherState` (or `WeatherController`)

**`src/game/Game.ts` or main game class**
- Ensure influence fields are computed before first frame
- May need loading state while propagation runs

---

## Execution Order

### Phase 0: Foundation (No Dependencies)

**Status:** [x] Complete

**Tasks:** (can be done in parallel)
- [x] Create `src/game/world-data/weather/WeatherState.ts`
  - Interface + default values, no dependencies
- [x] Create `src/game/world-data/influence/InfluenceFieldTypes.ts`
  - Type definitions only
- [x] Create `src/game/world-data/influence/InfluenceFieldGrid.ts`
  - Generic grid data structure, pure data
- [x] Create `src/game/world-data/influence/PropagationConfig.ts`
  - Configuration interfaces and defaults
- [x] Create `src/game/world-data/influence/index.ts`
  - Barrel export for influence module

**Checkpoint:** After Phase 0
- New files exist but aren't integrated into game yet
- Game compiles and runs exactly as before (no behavior changes)
- Commit message: `feat: add wind-wave foundation types`

**To verify:** `npm run tsgo` passes, game runs normally

---

### Phase 1: Terrain Sampling (Depends on: Phase 0)

**Status:** [ ] Not started

**Tasks:** (sequential)
- [ ] Create `src/game/world-data/influence/propagation/TerrainSampler.ts`
  - Wraps TerrainInfo for efficient propagation queries
  - Needs: InfluenceFieldTypes, existing TerrainInfo
- [ ] Add helper methods to `TerrainInfo.ts`
  - `getShoreDistance(point: V2d): number`
  - Ensure `getHeightAtPoint()` works efficiently for propagation

**Checkpoint:** After Phase 1
- TerrainSampler can query terrain boundaries
- New TerrainInfo methods work
- Game still runs normally (new code not yet called)
- Commit message: `feat: add terrain sampler for propagation`

**To verify:** Can instantiate TerrainSampler and query points

---

### Phase 2: Propagation Algorithms (Depends on: Phase 1)

**Status:** [ ] Not started

**Tasks:** (can be done in parallel)
- [ ] Create `src/game/world-data/influence/WindInfluencePropagation.ts`
  - Wind propagation algorithm
  - Needs: TerrainSampler, PropagationConfig, InfluenceFieldGrid
- [ ] Create `src/game/world-data/influence/SwellInfluencePropagation.ts`
  - Swell propagation (more diffraction)
  - Needs: TerrainSampler, PropagationConfig, InfluenceFieldGrid
- [ ] Create `src/game/world-data/influence/FetchMapComputation.ts`
  - Ray-marching fetch calculation
  - Needs: TerrainSampler, InfluenceFieldGrid

**Checkpoint:** After Phase 2
- Propagation algorithms exist and can be called
- Not yet integrated into game startup
- Commit message: `feat: add propagation algorithms`

**To verify:** Can call propagation functions with test terrain, get reasonable output

---

### Phase 3: Influence Field Storage (Depends on: Phase 2)

**Status:** [ ] Not started

**Tasks:** (can be done in parallel)
- [ ] Create `src/game/world-data/influence/WindInfluenceField.ts`
  - Stores propagation results, provides sampling
- [ ] Create `src/game/world-data/influence/SwellInfluenceField.ts`
  - Stores propagation results, provides sampling
- [ ] Create `src/game/world-data/influence/FetchMap.ts`
  - Stores fetch results, provides sampling

**Checkpoint:** After Phase 3
- Field classes can store and sample data
- Not yet populated with real propagation data
- Commit message: `feat: add influence field storage`

**To verify:** Can create field, populate with test data, sample at arbitrary points

---

### Phase 4: Manager and Integration (Depends on: Phase 3)

**Status:** [ ] Not started

**Tasks:** (sequential)
- [ ] Create `src/game/world-data/influence/InfluenceFieldManager.ts`
  - Orchestrates all propagation at startup
  - Provides unified sampling interface
  - Needs: All influence field classes
- [ ] Update `src/game/world-data/influence/index.ts`
  - Add exports for new field classes and manager (base exports added in Phase 0)
- [ ] Modify game startup (GameController or equivalent)
  - Initialize InfluenceFieldManager after terrain is defined
  - Log propagation time for profiling

**Checkpoint:** After Phase 4
- Influence fields are computed at game startup
- Can query influence at any point via manager
- Game runs, propagation happens, but wind/water don't use it yet
- Console shows propagation timing
- Commit message: `feat: add influence field manager`

**To verify:** Game starts, console shows "Propagation complete: Xms", game plays normally

---

### Phase 5: Wind System Updates (Depends on: Phase 4)

**Status:** [ ] Not started

**Tasks:** (sequential)
- [ ] Update `src/game/world-data/wind/WindConstants.ts`
  - Add influence-related constants
- [ ] Update `src/game/world-data/wind/webgpu/WindTileCompute.ts`
  - Accept influence parameters per tile
- [ ] Update `src/game/world-data/wind/webgpu/WindStateShader.ts` (WGSL)
  - Apply influence to wind calculation
- [ ] Update `src/game/world-data/wind/cpu/WindComputeCPU.ts`
  - Match GPU changes
- [ ] Update `src/game/world-data/wind/WindInfo.ts`
  - Get InfluenceFieldManager reference
  - Sample influence field for each tile
  - Pass influence params to tile compute

**Checkpoint:** After Phase 5
- Wind is now terrain-aware!
- Wind shadows visible behind islands
- Wind accelerates through gaps
- Wind visualization (press V) shows variation
- Sailing feels different near terrain
- Commit message: `feat: terrain-aware wind system`

**To verify:**
- Sail behind an island - wind should be lighter
- Sail through a channel - wind should be stronger
- Wind visualization shows shadows

---

### Phase 6: Water System Updates (Depends on: Phase 4, Phase 5)

**Status:** [ ] Not started

**Tasks:** (sequential)
- [ ] Update `src/game/world-data/water/WaterConstants.ts`
  - Add wave derivation constants
  - Keep old constants as fallback (feature flag)
- [ ] Create wave parameter derivation logic (in WaterInfo or separate file)
  - Derive Gerstner params from weather + influence + fetch
- [ ] Update `src/game/world-data/water/webgpu/WaterComputeBuffers.ts`
  - Support per-tile wave parameters (or add new buffer)
- [ ] Update `src/game/world-data/water/webgpu/WaterStateShader.ts` (WGSL)
  - Accept variable wave params per tile
  - Add shoaling factor input
  - Add damping factor input
- [ ] Update `src/game/world-data/water/webgpu/WaterDataTileCompute.ts`
  - Pass derived params to shader
- [ ] Update `src/game/world-data/water/cpu/WaterComputeCPU.ts`
  - Match GPU changes
- [ ] Update `src/game/world-data/water/WaterInfo.ts`
  - Get InfluenceFieldManager reference
  - Derive wave params per tile from weather + influence + fetch
  - Query terrain for depth/shoaling

**Checkpoint:** After Phase 6
- Waves are now terrain-aware!
- Bays have calmer water (diffracted swell only)
- Open ocean has full waves
- Waves change character near shore (shoaling)
- Commit message: `feat: terrain-aware wave system`

**To verify:**
- Sail into a bay - waves should be gentler
- Compare open ocean vs sheltered area
- Waves near shore should look different than deep water

---

### Phase 7: Polish and Tuning (Depends on: Phase 6)

**Status:** [ ] Not started

**Tasks:** (can be done in parallel, iterative)
- [ ] Tune propagation parameters
  - Direct flow vs lateral spread ratios
  - Decay rates
  - Diffraction coefficients for different wavelengths
- [ ] Tune wave derivation
  - Fetch-to-amplitude relationship
  - Shoaling curve
  - Damping curve
- [ ] Add visualization/debugging (optional)
  - Influence field visualization
  - Wave parameter overlay
- [ ] Performance optimization (if needed)
  - Profile propagation time
  - GPU-accelerate propagation if too slow

**Checkpoint:** After Phase 7
- System feels polished and realistic
- Performance is acceptable (startup < 5s, no frame drops)
- Commit message: `feat: tune wind-wave parameters`

**To verify:**
- Gameplay feels good
- Different areas have distinct character
- No performance issues

---

### Optional Phase 8: Weather Evolution

**Status:** [ ] Not started (optional)

**Tasks:** (sequential)
- [ ] Create `src/game/world-data/weather/WeatherController.ts`
  - Entity that evolves weather over time
  - Wind shifts, swell builds/decays
- [ ] Handle weather changes in wind/water systems
  - May need to invalidate/update some cached data
  - Or just let tile system naturally update

**Checkpoint:** After Phase 8
- Weather changes over time
- Wind shifts direction gradually
- Swell builds and decays
- Commit message: `feat: weather evolution`

---

### Optional Phase 9: Currents

**Status:** [ ] Not started (optional)

**Tasks:** (sequential)
- [ ] Create `src/game/world-data/influence/CurrentField.ts`
  - Base flow patterns
  - Tidal modulation
- [ ] Integrate with WaterInfo
  - Add current to water velocity

**Checkpoint:** After Phase 9
- Currents flow through narrows
- Tidal currents reverse with tide
- Commit message: `feat: terrain-aware currents`

---

## Testing Strategy

### Unit Tests

- Propagation algorithms produce expected patterns
- Influence field sampling interpolates correctly
- Wave parameter derivation follows expected curves

### Visual Tests

- Wind visualization shows shadows behind islands
- Wave amplitude varies visually near terrain
- Bays appear calmer than open ocean

### Gameplay Tests

- Sailing behind island feels different (lighter wind)
- Entering bay through inlet shows wave character change
- Sailing windward shore vs lee shore feels different

---

## Risk Mitigation

### Startup Time
- **Risk:** Propagation takes too long
- **Mitigation:** Profile early, GPU-accelerate if needed, or compute async during loading

### Memory Usage
- **Risk:** Influence fields are too large
- **Mitigation:** Use coarse resolution (100m), compress if needed

### Visual Discontinuities
- **Risk:** Tile boundaries show artifacts
- **Mitigation:** Ensure smooth interpolation between influence field cells

### Compatibility
- **Risk:** Changes break existing sailing behavior
- **Mitigation:** Keep existing wave sources as fallback option, feature flag new system

---

## Success Criteria

1. **Wind shadows are visible** - Lee of islands has noticeably less wind
2. **Bays feel sheltered** - Less wave activity inside protected areas
3. **Fetch matters** - Wind waves are smaller near upwind shores
4. **Diffraction works** - Waves enter bays through inlets, spread out
5. **Performance acceptable** - Startup < 5 seconds, no runtime frame drops
6. **No regressions** - Sailing still feels good, boat physics work correctly

---

## Updating This Plan

When working on this plan:

1. **Before starting a session:**
   - Read the "Progress Tracking" section to see current status
   - Check the last completed phase's checkpoint notes
   - Update "Current Status" and "Next Step" fields

2. **While working:**
   - Check off completed tasks with `[x]`
   - Update phase status: `[ ] Not started` → `[~] In progress` → `[x] Complete`
   - Add notes about any issues or changes to the plan

3. **After completing a phase:**
   - Verify the checkpoint criteria
   - Make a commit with the suggested message
   - Update the Progress Tracking table
   - Add an entry to the Change Log below

4. **If the plan needs to change:**
   - Document why in the Change Log
   - Update affected phases
   - Don't delete old content - strike it out or note what changed

---

## Change Log

Record significant progress and plan updates here:

| Date | Phase | Notes |
|------|-------|-------|
| (date) | Plan created | Initial plan based on design docs |
| 2026-01-20 | Phase 0 complete | Foundation types created: WeatherState, InfluenceFieldTypes, InfluenceFieldGrid, PropagationConfig, index.ts |

---

## Session Notes

Use this space for notes during implementation sessions:

### Session: (date)
**Goal:**
**Completed:**
**Issues:**
**Next time:**
