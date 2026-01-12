# Water System Implementation Plan

This plan outlines enhancements to the water system. The core system has been implemented with WebGPU-based waves, noise-based currents, and particle-based wakes.

## Current State

### Implemented Architecture

```
src/game/water/
├── WaterInfo.ts              # Central query point, integrates all sources
├── WaterConstants.ts         # Shared constants
├── WaterModifier.ts          # Interface for wakes and other modifiers
├── Wake.ts                   # Wake spawner (from boat)
├── WakeParticle.ts           # Individual wake particles (WaterModifier)
├── water-helpers.ts          # Shared math utilities
├── cpu/
│   └── WaterComputeCPU.ts    # CPU fallback for wave computation
└── webgpu/
    ├── WaveComputeGPU.ts     # GPU Gerstner wave computation
    ├── WaterShaderGPU.ts     # Water surface rendering
    ├── WaterRendererGPU.ts   # Orchestrates compute + rendering
    ├── WaterComputePipelineGPU.ts  # Compute pipeline management
    ├── WaterReadbackBuffer.ts     # GPU→CPU readback for physics
    ├── waveCompute.wgsl      # WGSL wave compute shader
    └── water.wgsl            # WGSL surface fragment shader
```

### Core Interface (WaterInfo.ts)

```typescript
interface WaterState {
  velocity: V2d;          // Combined current + modifier velocities
  surfaceHeight: number;  // Wave displacement at this point
  surfaceHeightRate: number; // dh/dt for buoyancy
}
```

### What's Been Implemented

**Phase 1: Water Entity Foundation** ✓
- [x] WaterInfo entity as central query point with id "waterInfo"
- [x] `getStateAtPoint()` returning wave height, velocity, height rate
- [x] Integration with Keel, Rudder, Hull via `WaterInfo.getStateAtPoint()`
- [x] Spatial hash for efficient modifier queries

**Phase 2: Water Currents** ✓
- [x] Noise-based ambient current in WaterInfo
- [x] Spatial and temporal variation via simplex noise
- [x] Base current velocity with configurable direction/magnitude
- [ ] Tidal current (periodic magnitude/direction shifts)
- [ ] Channel flow (spline-based)
- [ ] Eddy currents (circular velocity fields)
- [ ] Current visualization (HUD indicator or particles)

**Phase 3: Wave System** ✓
- [x] Gerstner wave computation (GPU compute shader)
- [x] 12 wave components with configurable parameters
- [x] Amplitude modulation via simplex noise (wave groups)
- [x] Surface turbulence noise
- [x] GPU readback for physics queries
- [x] CPU fallback for out-of-viewport queries
- [x] Wave height used for buoyancy variation
- [ ] Wind-driven wave generation (waves align with wind)
- [ ] Surfing force when aligned with wave slope

**Phase 4: Wake System** ✓
- [x] Particle-based wake field (WakeParticle implements WaterModifier)
- [x] Wake spawning from boat stern (Wake.ts)
- [x] Particle chains for ribbon rendering
- [x] Velocity and height contributions
- [x] Expanding influence radius over lifetime
- [x] Warmup period before physics effects
- [x] Decay/aging and self-destruction
- [ ] Bow wave spray particles
- [ ] Kelvin wake pattern overlay (V-shaped visual)

---

## Remaining Work

### Priority 1: Current Enhancements

#### Tidal Current
Add periodic current variation for more dynamic sailing:

```typescript
// In WaterInfo.ts or new TidalCurrent.ts
interface TidalConfig {
  period: number;          // Tidal cycle in seconds (e.g., 600 for 10-min cycle)
  magnitude: number;       // How much current changes
  directionShift: number;  // Rotation in radians (0 for linear tides)
}

// Apply sinusoidal modulation to base current
const tidalPhase = (time % config.period) / config.period * 2 * Math.PI;
const tidalFactor = 1 + Math.sin(tidalPhase) * config.magnitude;
```

#### Current Indicator
Add visual feedback for current direction/strength:
- Option A: Arrow overlay on water (like wind indicator)
- Option B: Subtle directional particles/streaks
- Option C: HUD compass element

### Priority 2: Wind-Wave Coupling

Make waves respond to wind conditions:

```typescript
// In WaveComputeGPU.ts or WaterRendererGPU.ts
setWindConditions(windSpeed: number, windDirection: V2d) {
  // Adjust wave amplitudes based on wind speed
  // Rotate wave directions toward wind
  // Increase steepness with stronger wind
}
```

This would complement the water-shader-improvements.md foam/ripple work for a complete weather system.

### Priority 3: Eddy Currents

Localized circular flow fields for tactical sailing:

```typescript
interface Eddy {
  position: V2d;
  radius: number;          // Inner edge where velocity peaks
  outerRadius: number;     // Falloff distance
  strength: number;        // Max tangential velocity
  clockwise: boolean;      // Rotation direction
}

getEddyVelocity(queryPoint: V2d, eddy: Eddy): V2d {
  const toPoint = queryPoint.sub(eddy.position);
  const dist = toPoint.magnitude;

  if (dist < eddy.radius * 0.5 || dist > eddy.outerRadius) {
    return V(0, 0);
  }

  // Peak at radius, falloff both directions
  const falloff = 1 - Math.abs(dist - eddy.radius) / (eddy.outerRadius - eddy.radius);
  const tangent = toPoint.rotate90cw().normalize();
  return tangent.mul(eddy.strength * falloff * (eddy.clockwise ? 1 : -1));
}
```

### Priority 4: Visual Enhancements

#### Bow Wave
Spray particles at bow when moving fast:
- Spawn from hull leading edge
- Velocity based on boat speed + random spread
- Short lifespan, white/foam colored

#### Current Visualization
Subtle drift particles showing current flow:
- Low-opacity, small particles
- Spawn throughout visible area
- Drift with `WaterInfo.getCurrentVelocityAtPoint()`

---

## Design Decisions

1. **Wind-Wave Coupling Timing**: Use realistic lag (waves build/decay gradually as wind changes). Fall back to immediate updates only if performance is problematic.

2. **Eddy Placement**: TBD - either map-defined or procedural. Will be determined during world map design.

3. **Current Visualization**: Likely solved by foam particles drifting with current (see `water-shader-improvements.md`). Once foam is implemented, current direction should be visible from particle movement. May not need a separate indicator.

## Open Questions

1. **Multi-boat Wake Interaction**: Current system handles this, but do we need aggressive culling for many boats? Spatial hash helps, but particle count could grow.

---

## References

- Gerstner waves: https://en.wikipedia.org/wiki/Trochoidal_wave
- Kelvin wake pattern: https://en.wikipedia.org/wiki/Wake_(physics)
- Current sailing physics resources for realistic feel
