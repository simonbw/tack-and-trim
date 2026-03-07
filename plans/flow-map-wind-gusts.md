# Flow-Map Wind Gusts + Terrain Influence

## Overview

Replace the current stationary noise-based wind variation with flow-map advected gusts that follow terrain-curved wind paths. Then fill in real terrain influence values in the wind mesh so the gusts actually have curves to follow.

## Current State

- Wind mesh exists with full plumbing (Rust builder -> binary format -> TS loader -> GPU packed buffer -> shader lookup)
- All mesh vertex attributes are neutral (speedFactor=1.0, directionOffset=0.0, turbulence=0.0)
- Wind noise in `calculateWindVelocity` uses `simplex3D(x, y, t)` which evolves in place — doesn't scroll with wind direction at all
- Wind query shader already does mesh lookup and passes influence values to the wind function

## Phase 1: Flow-Map Gust Advection (Shader Only)

**Goal:** Make gusts move with the local wind direction using dual-layer flow-map technique.

**Files:**
- `src/game/world/shaders/wind.wgsl.ts` — rewrite `calculateWindVelocity` noise sampling
- `src/game/world/wind/WindConstants.ts` — add flow-map constants

**Approach:**
1. Compute local flow velocity from baseWind + influenceSpeedFactor + influenceDirectionOffset (all already passed as params)
2. Use dual-layer flow-map UV distortion:
   - Two time phases offset by half a cycle: `t0 = fract(time/period)`, `t1 = fract(time/period + 0.5)`
   - Each layer: `uv = (worldPos - localFlow * t * period) * spatialScale`
   - Blend weight: `abs(2*t0 - 1)` — peaks when other layer resets
   - `gustNoise = mix(noise(uv0), noise(uv1), blend)`
3. Keep a slow time component in the noise z-axis for organic temporal evolution
4. Speed noise and angle noise each get their own flow-map evaluation (offset sample coords)
5. Turbulence from mesh modulates noise amplitude (already done), and also attenuates gust strength in wind shadows (speedFactor < 1 should reduce noise amplitude too)

**Verification:** With neutral mesh values, local flow = baseWind everywhere, so gusts should uniformly scroll in the wind direction. Visually: wind particles should show coherent puffs moving downwind instead of a boiling pattern.

**New constants needed:**
- `WIND_FLOW_CYCLE_PERIOD` — how long before a flow-map layer resets (e.g. 15-20 seconds). Longer = gusts travel further before the blend recycles, but more UV stretching. Should be long enough that a gust visibly crosses the player's field of view.
- `WIND_SLOW_TIME_SCALE` — rate of slow temporal evolution in noise z-axis (much slower than current `noiseTimeScale`)

## Phase 2: Terrain Wind Influence (Rust Pipeline)

**Goal:** Compute real speedFactor, directionOffset, and turbulence values per wind mesh vertex.

**Files:**
- `pipeline/wavemesh-builder/src/windmesh.rs` — replace neutral values with computed terrain influence

**Approach (single wind direction first):**

### Speed Factor (wind shadow + speed-up)
- For each mesh vertex, cast a ray upwind and check terrain intersection
- If terrain blocks line-of-sight to upwind: compute shelter factor based on terrain height and distance
- If vertex is on elevated terrain: speed-up factor (compressed airflow over ridges)
- Shelter zone extends ~15-20x obstacle height downwind, decaying with distance

### Direction Offset (flow deflection)
- Compute terrain gradient at each vertex (reuse existing analytical gradient from terrain.rs)
- Wind deflects perpendicular to terrain gradient (flows along contours of equal height)
- Stronger deflection near steep terrain, fading with distance
- Could also use a simple potential-flow model: treat terrain contours as streamline boundaries

### Turbulence
- High in the immediate lee of terrain (recirculation zone, ~5x obstacle height)
- Moderate in the extended wind shadow
- Low in open water and on windward faces

**Verification:** Load a level, enable WindMeshDebugMode, visually confirm that vertices behind islands show reduced speedFactor, vertices in straits show increased speedFactor, direction offsets curve around headlands.

## Phase 3: Multi-Direction Mesh Support

**Goal:** Make terrain influence correct for any base wind direction by precomputing N canonical directions.

**Files (Rust):**
- `windmesh.rs` — run influence computation for N directions (e.g. 8 or 16)
- `windmesh_file.rs` — expand format: store N attribute sets per vertex + list of canonical angles

**Files (TypeScript):**
- `src/pipeline/mesh-building/WindmeshFile.ts` — parse expanded format
- `src/game/wind/WindMeshPacking.ts` — pack N attribute sets per vertex
- `src/game/world/shaders/wind-mesh-packed.wgsl.ts` — `lookupWindMesh` takes wind direction, interpolates between two nearest precomputed direction slices
- `src/game/world/wind/WindQueryShader.ts` — pass base wind direction to lookup

**Vertex format change:** `[x, y, speedFactor_0, dirOffset_0, turb_0, ..., speedFactor_N-1, dirOffset_N-1, turb_N-1]`
- 5 floats/vertex -> `2 + 3*N` floats/vertex (e.g. 26 for N=8, 50 for N=16)

## Parallelization

- **Phase 1 and Phase 2 are independent** — shader work is pure TypeScript/WGSL, terrain influence is pure Rust
- **Phase 3 depends on Phase 2** for the actual computed values, but the format/plumbing expansion could be done in parallel if the vertex layout is agreed upon
