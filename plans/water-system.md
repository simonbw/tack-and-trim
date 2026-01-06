# Water System Implementation Plan

This plan outlines the implementation of a dynamic water system with currents, waves, and physics-affecting wakes.

## Overview

The water system will provide a unified velocity field that underwater components (keel, rudder, hull) can query, similar to how the wind system works. It consists of three main subsystems:

1. **Water Currents** - Base water movement (tidal, channel flows, eddies)
2. **Wave System** - Surface displacement + orbital velocities
3. **Wake Field** - Boat-generated disturbances that affect other objects

## Architecture

### File Structure

```
src/game/water/
├── Water.ts              # Main entity, combines all sources
├── WaterCurrent.ts       # Base current (noise + flow regions)
├── WaveSystem.ts         # Wave height + orbital velocity
├── WakeField.ts          # Wake velocity disturbances
└── water-helpers.ts      # Shared math (Gerstner, etc.)
```

### Core Interface

```typescript
interface WaterState {
  velocity: V2d;          // Combined current + wave orbital + wake velocity
  surfaceHeight: number;  // Wave displacement at this point
  surfaceNormal: V2d;     // For rendering/buoyancy direction
  wakeIntensity: number;  // For visual effects (foam, spray)
}
```

### Integration Points

- `Water.getStateAtPoint(point: V2d): WaterState` - Main query function
- Underwater components call this instead of returning `V(0,0)` for fluid velocity
- Wake spawning called from boat entities during `onTick()`
- Graphics layers query for surface height and wake intensity

---

## Phase 1: Water Entity Foundation

### Goals
- Create the Water entity as a central query point
- Refactor existing water rendering into the new system
- Set up the integration with fluid dynamics

### Tasks

#### 1.1 Create Water Entity Structure
- [ ] Create `src/game/water/Water.ts` with basic entity structure
- [ ] Register with id `"water"` for global access
- [ ] Move existing water background rendering from `src/game/Water.ts`
- [ ] Add `getStateAtPoint()` method returning static values initially

#### 1.2 Create Helper Module
- [ ] Create `src/game/water/water-helpers.ts`
- [ ] Add vector math utilities specific to water calculations
- [ ] Add constants for water physics (density ratio to air, etc.)

#### 1.3 Integrate with Fluid Dynamics
- [ ] Modify `Keel.ts` to query water velocity instead of `V(0,0)`
- [ ] Modify `Rudder.ts` similarly
- [ ] Modify `Hull.ts` underwater edge calculations
- [ ] Verify boat behavior unchanged with zero water velocity

---

## Phase 2: Water Currents

### Goals
- Implement spatially and temporally varying water currents
- Support multiple current source types

### Design

Currents use a layered approach where multiple sources sum together:

```typescript
interface CurrentSource {
  getVelocityAt(point: V2d, time: number): V2d;
}
```

#### Current Types

1. **Noise-based ambient current** - Similar to wind, uses simplex noise
2. **Tidal current** - Sinusoidal direction/magnitude shift over time
3. **Channel flow** - Velocity along a defined path/spline
4. **Eddy** - Circular velocity field at a point with distance falloff

### Tasks

#### 2.1 Ambient Current (Noise-based)
- [ ] Create `src/game/water/WaterCurrent.ts`
- [ ] Implement 3D simplex noise sampling (spatial x, y + time)
- [ ] Add configurable parameters:
  - Base velocity (direction + magnitude)
  - Spatial scale (how quickly current varies across space)
  - Time scale (how quickly current changes over time)
  - Variation magnitude (how much it deviates from base)
- [ ] Integrate into `Water.getStateAtPoint()`

#### 2.2 Current Source Interface
- [ ] Define `CurrentSource` interface
- [ ] Refactor noise current to implement interface
- [ ] Add source composition in Water entity (sum of all sources)

#### 2.3 Tidal Current (Optional Enhancement)
- [ ] Implement `TidalCurrent` class
- [ ] Sinusoidal magnitude variation over configurable period
- [ ] Optional direction shift (rotating tides)

#### 2.4 Eddy Current (Optional Enhancement)
- [ ] Implement `Eddy` class
- [ ] Circular velocity field (tangent to radius from center)
- [ ] Distance-based falloff (strongest at edge, zero at center and far away)
- [ ] Configurable: position, radius, strength, rotation direction

#### 2.5 Visual Feedback
- [ ] Modify `WaterParticles.ts` to drift with current velocity
- [ ] Add subtle directional streaks or flow lines
- [ ] Consider current indicator on HUD (like wind indicator)

---

## Phase 3: Wave System

### Goals
- Implement waves with both visual displacement and physics effects
- Support multiple wave components that sum together
- Provide orbital velocities for physics integration

### Design

Use Gerstner waves for physically accurate motion:

```typescript
interface WaveComponent {
  amplitude: number;      // Wave height (meters)
  wavelength: number;     // Distance between crests
  direction: V2d;         // Normalized propagation direction
  steepness: number;      // 0-1, affects wave shape (0=sine, 1=sharp crests)
  phase: number;          // Phase offset for variety
}

interface WaveState {
  height: number;         // Vertical displacement
  displacement: V2d;      // Horizontal displacement (Gerstner)
  orbitalVelocity: V2d;   // Water particle velocity
  slope: V2d;             // Surface gradient (for normal calculation)
}
```

#### Gerstner Wave Math

For a single wave component:
```
displacement.x = (steepness * amplitude) * cos(k·x - ωt)
displacement.y = amplitude * sin(k·x - ωt)

where:
  k = 2π / wavelength (wave number)
  ω = sqrt(g * k) (angular frequency, deep water)
  x = dot(point, direction) (distance along wave direction)
```

Orbital velocity is the time derivative of displacement.

### Tasks

#### 3.1 Wave Math Implementation
- [ ] Create `src/game/water/WaveSystem.ts`
- [ ] Implement single Gerstner wave calculation
- [ ] Implement wave superposition (sum multiple components)
- [ ] Calculate orbital velocity from wave parameters
- [ ] Calculate surface slope/normal

#### 3.2 Wave Configuration
- [ ] Define default wave components (2-4 waves of different scales)
- [ ] Consider wind-driven wave generation (waves align with wind direction)
- [ ] Add parameters for overall wave intensity/calmness

#### 3.3 Physics Integration
- [ ] Add orbital velocity to Water.getStateAtPoint() velocity sum
- [ ] Implement buoyancy variation based on surface height
  - Option A: Modulate existing forces based on wave height
  - Option B: Add explicit buoyancy force based on submersion depth
- [ ] Consider "surfing" force when boat aligned with wave slope

#### 3.4 Wave Graphics - Basic
- [ ] Add wave height to WaterState for rendering queries
- [ ] Modify water rendering to show surface displacement
- [ ] Options:
  - Shader-based vertex displacement on water mesh
  - Parallax sprite layers with wave textures
  - Height-based color variation (darker in troughs)

#### 3.5 Wave Graphics - Enhanced (Optional)
- [ ] Add foam/whitecap sprites at wave crests
- [ ] Animated wave crest highlights
- [ ] Boat interaction (spray when hitting waves)

---

## Phase 4: Wake System

### Goals
- Boats generate wakes that persist and spread
- Wakes affect physics of other objects (including the generating boat in some cases)
- Visual wake rendering enhanced with physics data

### Design Options

#### Option A: Particle-Based (Recommended for Initial Implementation)

```typescript
interface WakeParticle {
  position: V2d;
  velocity: V2d;        // Initial outward velocity from boat path
  intensity: number;    // Decays over time
  age: number;
  maxAge: number;
}
```

Pros: Simple, handles multiple boats naturally, easy to visualize
Cons: O(n) queries without spatial optimization

#### Option B: Grid-Based (Future Enhancement)

Store velocity field on a grid, splat disturbances, diffuse over time.
More complex but enables richer fluid interactions.

#### Option C: Analytical Kelvin Wake (Alternative)

Mathematical model of wake pattern. Accurate shape but less dynamic.

### Tasks

#### 4.1 Wake Field Foundation
- [ ] Create `src/game/water/WakeField.ts`
- [ ] Implement particle storage and lifecycle
- [ ] Add particle spawning (position, velocity, intensity)
- [ ] Add decay/aging logic in `step(dt)`
- [ ] Implement velocity query with distance falloff

#### 4.2 Wake Spawning from Boats
- [ ] Identify wake spawn points (stern, hull sides)
- [ ] Calculate wake particle initial velocity:
  - Direction: outward from boat centerline
  - Magnitude: proportional to boat speed
- [ ] Spawn rate proportional to boat speed
- [ ] Connect to existing Wake.ts entity or replace it

#### 4.3 Physics Integration
- [ ] Add wake velocity to Water.getStateAtPoint()
- [ ] Test that wakes affect keels/rudders of nearby boats
- [ ] Tune falloff and intensity for good gameplay feel

#### 4.4 Spatial Optimization
- [ ] Implement spatial hashing for wake particles
- [ ] Only query nearby particles for velocity calculation
- [ ] Cull particles far from any boat/camera

#### 4.5 Enhanced Wake Visuals
- [ ] Use wake particle data to drive visual intensity
- [ ] Kelvin wake pattern overlay (V-shaped texture/sprites)
- [ ] Foam trails with physics-based spreading
- [ ] Bow wave spray particles

---

## Phase 5: Graphics Polish

### Goals
- Cohesive visual style for all water effects
- Performance-optimized rendering

### Tasks

#### 5.1 Unified Water Rendering
- [ ] Review layer organization for water effects
- [ ] Ensure consistent art style across:
  - Base water color/texture
  - Wave displacement/highlights
  - Wake trails and foam
  - Particle effects

#### 5.2 Shader Effects (If Using WebGL)
- [ ] Water surface shader with:
  - Wave vertex displacement
  - Fresnel-based reflection hint
  - Foam/wake intensity overlay
- [ ] Consider underwater caustics

#### 5.3 Performance Optimization
- [ ] Profile water system CPU usage
- [ ] Implement LOD for distant waves
- [ ] Particle pooling for wakes
- [ ] Query caching for multiple components sampling same point

---

## Phase 6: Tuning and Polish

### Goals
- Gameplay feels good with all systems active
- Systems interact well together
- Performance is acceptable

### Tasks

#### 6.1 Physics Tuning
- [ ] Balance current strength vs. wind strength
- [ ] Tune wave orbital velocity magnitude
- [ ] Adjust wake influence radius and decay
- [ ] Test multiple boats interacting via wakes

#### 6.2 Visual Tuning
- [ ] Wave scale appropriate for boat size
- [ ] Wake spread rate looks natural
- [ ] Current visualization readable but not distracting

#### 6.3 Performance Testing
- [ ] Test with many boats (wake particle count)
- [ ] Test with complex wave patterns
- [ ] Ensure consistent frame rate

#### 6.4 Edge Cases
- [ ] Behavior at map boundaries
- [ ] Very high speeds
- [ ] Stationary boat in strong current/waves

---

## Implementation Order Recommendation

1. **Phase 1** - Foundation (required for all else)
2. **Phase 2.1-2.2** - Basic currents (quick win, visible effect)
3. **Phase 4.1-4.3** - Basic wake physics (exciting feature)
4. **Phase 3.1-3.3** - Wave physics (complex but high impact)
5. **Phase 3.4** - Wave graphics (visual payoff)
6. **Phase 4.4-4.5** - Wake polish
7. **Phase 2.3-2.5** - Current enhancements
8. **Phase 5-6** - Polish passes

---

## Open Questions

1. **Wave-Wind Coupling**: Should waves automatically align with wind direction? Or be independently configured?

2. **Buoyancy Model**: Explicit buoyancy force vs. modulating existing drag? Explicit is more physically accurate but adds complexity.

3. **Wake Self-Interaction**: Should a boat's own wake affect it? (Probably not for gameplay, but might look weird if it clearly doesn't)

4. **Multi-boat Wakes**: How many wake particles can we support? May need aggressive culling or grid approach for many boats.

5. **Current Visualization**: How prominent should current indicators be? Subtle particles vs. explicit HUD element?

---

## References

- Gerstner waves: https://en.wikipedia.org/wiki/Trochoidal_wave
- Kelvin wake pattern: https://en.wikipedia.org/wiki/Wake_(physics)
- Tessendorf "Simulating Ocean Water" (classic wave rendering paper)
- Current sailing physics resources for realistic feel
