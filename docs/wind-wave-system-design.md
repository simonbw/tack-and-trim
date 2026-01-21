# Wind & Wave System Design

## Overview

This document describes the computational architecture for simulating wind and waves in Tack & Trim. The system produces spatially-varying wind and wave conditions that respond to terrain geography and weather state.

**Design goals:**
- Ocean feels alive and varied across the world
- Different locations have distinct character based on geography
- Computationally efficient (pre-compute what we can, compute on-demand otherwise)
- Integrates with existing tile-based data pipeline

**See also:** [Wind & Wave Physics Reference](./wind-wave-physics.md) for the underlying phenomena.

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           WEATHER STATE                                 │
│                     (Global, changes slowly)                            │
│   • Wind direction & speed                                              │
│   • Swell direction, amplitude, period                                  │
│   • Time of day (for tides)                                             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      PRE-COMPUTED INFLUENCE FIELDS                      │
│                  (Computed once at startup from terrain)                │
│                                                                         │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐        │
│   │   Wind Field    │  │   Swell Field   │  │    Fetch Map    │        │
│   │                 │  │                 │  │                 │        │
│   │ Per direction:  │  │ Per direction:  │  │ Per direction:  │        │
│   │ • Speed factor  │  │ • Energy factor │  │ • Distance to   │        │
│   │ • Direction     │  │ • Arrival       │  │   open water    │        │
│   │   offset        │  │   direction     │  │                 │        │
│   │ • Turbulence    │  │                 │  │                 │        │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘        │
│                                                                         │
│   ┌─────────────────┐  ┌─────────────────┐                             │
│   │  Current Field  │  │   Depth Field   │                             │
│   │  (base flow)    │  │  (from terrain) │                             │
│   └─────────────────┘  └─────────────────┘                             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         TILE COMPUTATION                                │
│                    (On-demand, per data tile)                           │
│                                                                         │
│   For each active tile, combine:                                        │
│   • Sample pre-computed fields for tile location                        │
│   • Apply current weather state                                         │
│   • Compute local modifiers (shoaling, damping)                         │
│   • Derive final wave parameters                                        │
│                                                                         │
│   Output: Per-pixel wind velocity, wave parameters                      │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       SURFACE EVALUATION                                │
│                      (Per query, runtime)                               │
│                                                                         │
│   • Sample tile data at query point                                     │
│   • Evaluate Gerstner waves with local parameters                       │
│   • Return: surface height, surface velocity, wind velocity             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 0: Weather State

### Purpose

Defines the global atmospheric and oceanic conditions that drive everything else. This is the "input" to the system.

### Data Structure

```typescript
interface WeatherState {
  // Primary wind
  wind: {
    direction: number;       // radians, direction wind is coming FROM
    speed: number;           // ft/s (or knots, choose unit)
    gustFactor: number;      // multiplier for gust intensity (0.1 = 10% gusts)
  };

  // Primary swell (distant weather)
  swell: {
    direction: number;       // radians, direction swell is coming FROM
    amplitude: number;       // ft, significant wave height
    period: number;          // seconds, wave period
  };

  // Optional: secondary swell
  secondarySwell?: {
    direction: number;
    amplitude: number;
    period: number;
  };

  // Tidal state
  tide: {
    phase: number;           // 0-1, where in tidal cycle (0.5 = high tide)
    range: number;           // ft, difference between high and low
  };
}
```

### Update Frequency

- **Slow changes**: Weather evolves over minutes to hours of game time
- **Could be procedural**: Wind slowly shifts, swell builds/decays
- **Or designed**: Predefined weather patterns that cycle

### Open Questions

- How complex should weather evolution be?
- Should weather vary by world region?
- Do we want weather events (storms, fronts)?

---

## Layer 1: Pre-computed Influence Fields

These fields capture how terrain affects wind and waves. Computed once at game startup (or when terrain changes), then sampled at runtime.

### 1.1 Wind Influence Field

#### What It Captures

For each point, how does terrain modify wind from each direction?

- **Speed factor**: 0.0 (fully blocked) to 1.5+ (accelerated through gap)
- **Direction offset**: How much wind direction bends
- **Turbulence factor**: How gusty/variable the wind is

#### Computation Method: Propagation

Simulate wind "energy" flowing through terrain:

```
For each source direction D (e.g., 16 directions around compass):
  1. Initialize: Full wind energy at world boundaries and open areas
  2. Iterate until convergence:
     - Energy flows primarily in direction D
     - Energy spreads laterally (simulates flow around obstacles)
     - Land cells absorb all energy
     - Track cumulative direction deflection
     - Track turbulence (increases in wake of obstacles)
  3. Store results for direction D
```

#### Data Layout

```typescript
interface WindInfluenceField {
  resolution: number;              // meters per cell (e.g., 50-100m)
  directions: number;              // number of pre-computed directions (e.g., 16)

  // Per cell, per direction:
  speedFactor: Float32Array;       // [cell][direction] → 0.0-1.5
  directionOffset: Float32Array;   // [cell][direction] → radians
  turbulenceFactor: Float32Array;  // [cell][direction] → 0.0-1.0
}
```

#### Runtime Sampling

```typescript
function getLocalWind(position: Vec2, weather: WeatherState): LocalWind {
  // Find which pre-computed directions bracket the current wind
  const dirIndex = weather.wind.direction / (2 * PI) * numDirections;
  const dir0 = floor(dirIndex) % numDirections;
  const dir1 = (dir0 + 1) % numDirections;
  const blend = dirIndex - floor(dirIndex);

  // Sample influence field
  const influence0 = sampleInfluence(position, dir0);
  const influence1 = sampleInfluence(position, dir1);
  const influence = lerp(influence0, influence1, blend);

  // Apply to weather wind
  return {
    speed: weather.wind.speed * influence.speedFactor,
    direction: weather.wind.direction + influence.directionOffset,
    turbulence: influence.turbulenceFactor,
  };
}
```

### 1.2 Swell Influence Field

#### What It Captures

For each point, how does terrain affect swell from each direction?

- **Energy factor**: 0.0 (fully blocked) to 1.0 (full exposure)
- **Arrival direction**: May differ from source due to diffraction

#### Computation Method: Wave Energy Propagation

Similar to wind, but with different physics:

```
For each source direction D:
  1. Initialize: Full wave energy at world boundaries
  2. Iterate until convergence:
     - Energy flows primarily in direction D
     - Energy spreads laterally MORE than wind (waves diffract more)
     - Spreading amount depends on wavelength (longer = more diffraction)
     - Land cells absorb all energy
     - Shallow cells slow propagation (refraction)
     - Track energy-weighted arrival direction
  3. Store results for direction D
```

**Key difference from wind**: More lateral spreading to capture diffraction. The spreading coefficient should be tunable per wavelength class.

#### Data Layout

```typescript
interface SwellInfluenceField {
  resolution: number;              // meters per cell
  directions: number;              // number of pre-computed directions
  wavelengthClasses: number;       // e.g., 2: "long swell" and "short chop"

  // Per cell, per direction, per wavelength class:
  energyFactor: Float32Array;      // [cell][direction][wavelength] → 0.0-1.0
  arrivalDirection: Float32Array;  // [cell][direction][wavelength] → radians
}
```

#### Why Multiple Wavelength Classes?

Long waves diffract more than short waves:
- **Long swell** (100m+ wavelength): Bends significantly around islands, enters bays
- **Short chop** (5-20m wavelength): Sharper shadows, more blocked

We might pre-compute 2-3 wavelength classes with different diffraction coefficients.

### 1.3 Fetch Map

#### What It Captures

For each point and direction: how much open water is in that direction?

This determines how much wind-wave development can occur.

#### Computation Method: Ray Marching

```
For each cell, for each direction D:
  March a ray in direction D
  Count distance until hitting land (or reaching max fetch)
  Store distance
```

Simple and efficient. Can be parallelized.

#### Data Layout

```typescript
interface FetchMap {
  resolution: number;              // meters per cell
  directions: number;              // number of directions

  // Per cell, per direction:
  fetchDistance: Float32Array;     // [cell][direction] → meters (capped at max)
}
```

#### Runtime Use

```typescript
function getLocalFetch(position: Vec2, windDirection: number): number {
  // Wind waves come FROM the wind direction, so fetch is in that direction
  const dirIndex = windDirection / (2 * PI) * numDirections;
  // Interpolate between bracketing directions
  return interpolateFetch(position, dirIndex);
}
```

### 1.4 Current Field (Base Flow)

#### What It Captures

Base current patterns driven by terrain geometry:
- Flow through narrows (water takes shortest path)
- Circulation patterns in bays
- Tidal flow directions (which way does water go when tide rises/falls?)

#### Computation Method

Options (in order of complexity):
1. **Designer-placed**: Manually define current vectors in key areas
2. **Distance-based**: Current flows through shortest water path between open areas
3. **Flow simulation**: Solve simplified fluid equations with terrain as boundaries

Recommend starting with option 1 or 2.

#### Data Layout

```typescript
interface CurrentField {
  resolution: number;              // meters per cell

  // Base current direction and magnitude
  baseFlow: Vec2[];                // [cell] → velocity vector

  // Tidal modulation: how much does tide affect this cell?
  tidalInfluence: Float32Array;    // [cell] → 0.0-1.0
  tidalDirection: Float32Array;    // [cell] → radians (flow direction on rising tide)
}
```

#### Runtime Use

```typescript
function getLocalCurrent(position: Vec2, weather: WeatherState): Vec2 {
  const base = sampleBaseFlow(position);

  // Tidal component
  const tidalInfluence = sampleTidalInfluence(position);
  const tidalDir = sampleTidalDirection(position);
  const tidalPhaseVelocity = sin(weather.tide.phase * 2 * PI); // -1 to 1
  const tidalCurrent = vec2FromAngle(tidalDir).mul(tidalInfluence * tidalPhaseVelocity * TIDAL_CURRENT_SCALE);

  // Wind-driven surface current (simple)
  const windCurrent = vec2FromAngle(weather.wind.direction + PI).mul(weather.wind.speed * WIND_CURRENT_FACTOR);

  return base.add(tidalCurrent).add(windCurrent);
}
```

### 1.5 Resolution Considerations

| Field | Recommended Resolution | Rationale |
|-------|------------------------|-----------|
| Wind influence | 50-100m | Wind shadows are large-scale |
| Swell influence | 50-100m | Diffraction happens over ~wavelength scale |
| Fetch map | 100-200m | Fetch varies slowly |
| Current field | 50-100m | Currents can have local variation |

These are much coarser than terrain/water data tiles (which might be ~1m resolution). That's intentional - these are large-scale effects.

### 1.6 Propagation Algorithm Details

#### Basic Algorithm

```
function propagateField(terrain, sourceDirection, config):
  // Initialize
  for each cell:
    if cell.isWater and cell.isAtBoundary(sourceDirection):
      cell.energy = 1.0
      cell.direction = sourceDirection
    else:
      cell.energy = 0.0

  // Iterate
  for iteration in 1..maxIterations:
    for each cell in order from upwind to downwind:
      if cell.isLand:
        cell.energy = 0.0
        continue

      // Gather energy from upwind neighbors
      totalEnergy = 0
      weightedDirection = vec2(0, 0)

      for each neighbor:
        flowDirection = normalize(cell.position - neighbor.position)
        alignment = dot(flowDirection, sourceDirection)

        if alignment > 0:  // neighbor is upwind
          // Direct flow component
          directWeight = alignment * config.directFlowFactor

          // Lateral spread component (diffraction)
          lateralWeight = (1 - abs(alignment)) * config.lateralSpreadFactor

          weight = (directWeight + lateralWeight) * config.decayFactor
          energyTransfer = neighbor.energy * weight

          totalEnergy += energyTransfer
          weightedDirection += flowDirection * energyTransfer

      cell.energy = min(totalEnergy, 1.0)
      cell.direction = normalize(weightedDirection)

    if converged():
      break

  return field
```

#### Tuning Parameters

```typescript
interface PropagationConfig {
  // How much energy flows directly forward (vs spreading)
  directFlowFactor: number;        // e.g., 0.8 for wind, 0.6 for waves

  // How much energy spreads laterally (diffraction)
  lateralSpreadFactor: number;     // e.g., 0.1 for wind, 0.3 for long swell

  // Energy decay per cell
  decayFactor: number;             // e.g., 0.98 (2% loss per cell)

  // Maximum iterations
  maxIterations: number;           // e.g., 100-500 depending on world size
}
```

#### GPU Acceleration

This propagation can be GPU-accelerated:
- Each iteration is a compute shader pass
- Ping-pong between two textures
- Run until energy change is below threshold

However, since this only runs at startup, CPU implementation may be acceptable.

---

## Layer 2: Tile Computation

### Purpose

Combine pre-computed influence fields with current weather state to produce actual wind/wave parameters for each data tile.

### When Computed

- When a tile is first requested (lazy)
- When weather state changes significantly (invalidate affected tiles)
- Cached until invalidated

### Input Data

For a tile at position P:
1. Sample all influence fields at P
2. Current weather state
3. Local terrain depth (from terrain tile)

### Computation

```typescript
function computeWaveTile(tilePosition: Vec2, weather: WeatherState): WaveTileData {
  // 1. Get local wind
  const wind = getLocalWind(tilePosition, weather);

  // 2. Get swell that reaches here
  const swellInfluence = sampleSwellField(tilePosition, weather.swell.direction);

  // 3. Get local fetch for wind waves
  const fetch = getLocalFetch(tilePosition, wind.direction);

  // 4. Compute wind-wave amplitude from wind + fetch
  const windWaveAmplitude = computeWindWaveAmplitude(wind.speed, fetch);

  // 5. Get local depth for shoaling
  const depth = sampleTerrainDepth(tilePosition);
  const shoalingFactor = computeShoalingFactor(depth);

  // 6. Compute damping near shore
  const shoreDistance = sampleShoreDistance(tilePosition);
  const dampingFactor = computeDampingFactor(shoreDistance, depth);

  // 7. Combine into wave parameters
  return {
    // Swell component
    swellAmplitude: weather.swell.amplitude * swellInfluence.energyFactor * shoalingFactor * dampingFactor,
    swellDirection: swellInfluence.arrivalDirection,
    swellPeriod: weather.swell.period,

    // Wind wave component
    windWaveAmplitude: windWaveAmplitude * dampingFactor,
    windWaveDirection: wind.direction + PI, // waves travel opposite to wind source direction
    windWavePeriod: computeWindWavePeriod(wind.speed, fetch),

    // Wind for sail physics
    windSpeed: wind.speed,
    windDirection: wind.direction,
    windTurbulence: wind.turbulence,

    // Current
    current: getLocalCurrent(tilePosition, weather),
  };
}
```

### Key Formulas

#### Wind Wave Amplitude from Fetch

Simplified from Pierson-Moskowitz:
```typescript
function computeWindWaveAmplitude(windSpeed: number, fetch: number): number {
  // Fully developed wave height for this wind speed
  const H_max = 0.0246 * windSpeed * windSpeed;  // ft, with wind in ft/s

  // Development factor based on fetch (0-1)
  const FULL_DEVELOPMENT_FETCH = 50000; // ft (~15km)
  const development = Math.min(1, Math.sqrt(fetch / FULL_DEVELOPMENT_FETCH));

  return H_max * development;
}
```

#### Wind Wave Period from Fetch

```typescript
function computeWindWavePeriod(windSpeed: number, fetch: number): number {
  // Fully developed period
  const T_max = 0.71 * windSpeed;  // seconds, with wind in ft/s

  // Less developed = shorter period
  const FULL_DEVELOPMENT_FETCH = 50000;
  const development = Math.min(1, Math.sqrt(fetch / FULL_DEVELOPMENT_FETCH));

  return T_max * (0.5 + 0.5 * development);  // ranges from 50% to 100% of T_max
}
```

#### Shoaling Factor

Waves get taller in shallow water:
```typescript
function computeShoalingFactor(depth: number): number {
  const DEEP_WATER_THRESHOLD = 50;  // ft
  if (depth >= DEEP_WATER_THRESHOLD) {
    return 1.0;
  }

  // Green's law: H2/H1 = (d1/d2)^0.25
  // Reference depth = DEEP_WATER_THRESHOLD
  return Math.pow(DEEP_WATER_THRESHOLD / Math.max(depth, 1), 0.25);
}
```

#### Damping Factor

Waves are reduced near shore and in very shallow water:
```typescript
function computeDampingFactor(shoreDistance: number, depth: number): number {
  // Shore proximity damping
  const SHORE_DAMPING_DISTANCE = 100;  // ft
  const shoreDamping = smoothstep(0, SHORE_DAMPING_DISTANCE, shoreDistance);

  // Shallow water damping (bottom friction)
  const SHALLOW_DAMPING_DEPTH = 5;  // ft
  const depthDamping = smoothstep(0, SHALLOW_DAMPING_DEPTH, depth);

  return shoreDamping * depthDamping;
}
```

### Per-Pixel vs Per-Tile

Some values vary slowly and can be computed once per tile:
- Swell influence
- Fetch
- Base wind

Others should vary per-pixel within the tile:
- Depth (for shoaling)
- Shore distance (for damping)

The tile shader should sample these per-pixel from the terrain tile.

---

## Layer 3: Surface Evaluation

### Purpose

Given local wave parameters, evaluate the actual water surface height and velocity at a specific point.

### When Computed

- Every frame for rendering
- Every physics tick for boat physics
- Point queries for specific game logic

### Gerstner Wave Evaluation

The existing system presumably uses Gerstner waves. The enhancement is that wave parameters now vary spatially.

```typescript
function evaluateSurface(position: Vec2, time: number, waveParams: WaveTileData): SurfaceState {
  let height = 0;
  let velocity = new Vec2(0, 0);

  // Swell components (typically 2-3)
  const swellComponents = generateSwellComponents(waveParams);
  for (const wave of swellComponents) {
    const contribution = evaluateGerstner(position, time, wave);
    height += contribution.height;
    velocity = velocity.add(contribution.velocity);
  }

  // Wind wave components (typically 6-10)
  const windComponents = generateWindWaveComponents(waveParams);
  for (const wave of windComponents) {
    const contribution = evaluateGerstner(position, time, wave);
    height += contribution.height;
    velocity = velocity.add(contribution.velocity);
  }

  // Add current to velocity
  velocity = velocity.add(waveParams.current);

  return { height, velocity };
}
```

### Wave Component Generation

Convert wave parameters into Gerstner components:

```typescript
function generateSwellComponents(params: WaveTileData): GerstnerWave[] {
  const waves: GerstnerWave[] = [];

  // Primary swell
  waves.push({
    amplitude: params.swellAmplitude * 0.6,
    wavelength: wavelengthFromPeriod(params.swellPeriod),
    direction: params.swellDirection,
    steepness: 0.3,
    phase: 0,
  });

  // Secondary components for visual variety
  waves.push({
    amplitude: params.swellAmplitude * 0.3,
    wavelength: wavelengthFromPeriod(params.swellPeriod * 0.8),
    direction: params.swellDirection + 0.1,  // slight direction offset
    steepness: 0.3,
    phase: 1.5,
  });

  waves.push({
    amplitude: params.swellAmplitude * 0.2,
    wavelength: wavelengthFromPeriod(params.swellPeriod * 1.3),
    direction: params.swellDirection - 0.15,
    steepness: 0.25,
    phase: 3.0,
  });

  return waves;
}

function generateWindWaveComponents(params: WaveTileData): GerstnerWave[] {
  const waves: GerstnerWave[] = [];
  const baseWavelength = wavelengthFromPeriod(params.windWavePeriod);

  // Generate multiple components with spread directions
  const numComponents = 8;
  for (let i = 0; i < numComponents; i++) {
    const directionSpread = (i - numComponents / 2) * 0.15;  // ±0.6 radians spread
    const wavelengthVariation = 0.7 + Math.random() * 0.6;   // 70%-130% of base
    const amplitudeVariation = 0.5 + Math.random() * 0.5;    // 50%-100% of base

    waves.push({
      amplitude: params.windWaveAmplitude * amplitudeVariation / numComponents,
      wavelength: baseWavelength * wavelengthVariation,
      direction: params.windWaveDirection + directionSpread,
      steepness: 0.5,  // wind waves are steeper
      phase: Math.random() * 2 * Math.PI,
    });
  }

  return waves;
}
```

### Wavelength-Period Relationship

Deep water dispersion relation:
```typescript
function wavelengthFromPeriod(period: number): number {
  // λ = g * T² / (2π)
  const g = 32.2;  // ft/s² (or 9.8 m/s²)
  return g * period * period / (2 * Math.PI);
}
```

---

## Data Flow Summary

```
┌────────────────────┐
│   STARTUP TIME     │
└────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ 1. Load terrain definitions (landmass polygons)            │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ 2. Generate coarse grids covering terrain area             │
│    • Wind influence field                                  │
│    • Swell influence field (per wavelength class)          │
│    • Fetch map                                             │
│    • Current field (if computed, not designed)             │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ 3. For each pre-computed direction, run propagation        │
│    • ~16 directions × ~3 field types = ~48 propagations    │
│    • Each propagation: iterate until convergence           │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────┐
│   RUNTIME          │
└────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ 4. Weather state updates (slowly, or on events)            │
│    • Wind shifts                                           │
│    • Swell builds/decays                                   │
│    • Tide phase advances                                   │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ 5. When data tile requested (rendering or physics):        │
│    a. Sample influence fields at tile location             │
│    b. Combine with current weather state                   │
│    c. Compute local wave parameters                        │
│    d. Run GPU shader to fill tile texture                  │
└────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ 6. Surface queries (per-frame for rendering, per-tick      │
│    for physics):                                           │
│    a. Sample wave parameters from tile                     │
│    b. Generate Gerstner components                         │
│    c. Evaluate surface height and velocity                 │
└────────────────────────────────────────────────────────────┘
```

---

## Integration with Existing Systems

### Terrain System

**Reads from:**
- Landmass definitions (for propagation boundaries)
- Terrain height (for depth calculations)
- Shore distance (for damping)

**No changes needed** to terrain system itself.

### Water System

**Replaces/enhances:**
- Current wave source definitions → derived from weather + influence fields
- Possibly current calculation → now includes terrain-aware currents

**Interface:**
- Water tile shader receives wave parameters
- Gerstner evaluation uses spatially-varying parameters

### Wind System

**Replaces/enhances:**
- Current simplex-noise wind → now terrain-aware with shadows and acceleration
- Wind at any point queries influence field + weather state

**Interface:**
- `WindInfo.getWindAtPoint(position)` now samples influence field

### Rendering

**May need updates:**
- Water shader receives wave parameters per tile
- Could add visual cues for wind (ripples in wind direction)
- Current visualization (arrows or streaks)

---

## Memory Estimates

### Pre-computed Fields

Assume world is ~10km × 10km with 100m resolution = 100×100 cells

| Field | Directions | Data per cell | Total |
|-------|------------|---------------|-------|
| Wind influence | 16 | 3 floats (12 bytes) | 1.9 MB |
| Swell influence | 16 × 2 wavelengths | 2 floats (8 bytes) | 2.5 MB |
| Fetch map | 16 | 1 float (4 bytes) | 640 KB |
| Current field | 1 | 4 floats (16 bytes) | 160 KB |

**Total: ~5 MB** for pre-computed fields (very manageable)

### Per-Tile Data

Existing tile system already handles this. Wave parameters add a few floats per tile, negligible.

---

## Startup Time Estimate

Propagation cost:
- ~50 propagations (16 directions × 3 fields + variations)
- Each propagation: ~100 iterations × 10,000 cells = 1M operations
- Total: ~50M simple operations

**Rough estimate: 1-5 seconds on CPU**, faster with GPU.

Acceptable for game startup. Could also be:
- Computed in background during loading screen
- Cached to disk after first computation
- Pre-computed as part of build for shipped terrain

---

## Open Design Questions

### Weather Evolution

1. **How does weather change?**
   - Procedural evolution (wind slowly shifts, swell builds/decays)?
   - Designer-authored weather patterns?
   - Player-facing weather forecast?

2. **How fast should changes be?**
   - Real: hours to days
   - Game: minutes to hours (compressed time?)

### Secondary Effects

1. **Wave-current interaction**: Opposing currents steepen waves. Worth modeling?

2. **Refraction detail**: Current design captures refraction approximately via propagation. Is higher-fidelity needed?

3. **Reflection**: Waves bouncing off cliffs. Worth adding to propagation?

### Tuning

1. **Propagation parameters**: Direct flow vs lateral spread ratios need tuning per effect type

2. **Wave component generation**: Number and distribution of Gerstner components affects visual quality

3. **Fetch relationship**: Constants in wind-wave formulas need validation

---

## Next Steps

1. **Code architecture design**: Define classes, interfaces, file structure
2. **Prototype propagation**: Test basic wind/wave propagation on simple terrain
3. **Integrate with tile system**: Hook up pre-computed fields to tile computation
4. **Tune and iterate**: Adjust parameters for good visual/gameplay results
