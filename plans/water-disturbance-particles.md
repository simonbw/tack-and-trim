# Water Disturbance Particle System

## Design Overview

### The Core Idea

Replace the current wake system — where particles move outward and use a capsule SDF for height — with a physics-based system where **stationary point sources emit expanding circular Gerstner wavelets**. Particles don't move; the wave propagates outward from where the disturbance occurred. The characteristic V-shaped Kelvin wake pattern emerges naturally from the superposition of expanding circles along the boat's path.

### Particle Model

Every water disturbance is the same type: a **disturbance particle**. Each particle is a point source that emits a single expanding Gerstner ring. Parameters:

| Parameter     | Type | Description                                                                                  |
| ------------- | ---- | -------------------------------------------------------------------------------------------- |
| position      | vec2 | Where the disturbance occurred (fixed after spawn)                                           |
| amplitude     | f32  | Initial wave height (ft). Decays over time.                                                  |
| wavelength    | f32  | Distance between wave crests (ft). Tied to boat speed for wakes: λ = 2πv²/g                  |
| steepness     | f32  | Gerstner Q parameter (0 = sine, 1 = sharp crests). Controls peaked-crest, flat-trough shape. |
| age           | f32  | Time since emission (seconds). Drives expanding radius and decay.                            |
| maxAge        | f32  | Lifespan before removal.                                                                     |
| decayRate     | f32  | Amplitude falloff rate. Wakes: slow (1/√r energy spreading). Splashes: fast.                 |
| turbulence    | f32  | Initial foam intensity (0-1). Decays with age. For stern churn.                              |
| initialRadius | f32  | Starting expansion radius (ft). 0 for bow wake points. Half-stern-width for stern particles. |

### Chain-Based Modifiers

Individual circular wavelets produce visible scalloping where they overlap. To solve this, a single `WaterModifier` entity owns an **entire chain of points** rather than each point being its own entity. The chain is a managed array of disturbance points within the modifier — new points are appended at the head, old points are trimmed from the tail as they age out.

When the modifier exports its data to the GPU buffer, the points are written contiguously in chain order. The shader iterates **segments** (pairs of adjacent points) rather than individual points, computing **distance-to-line-segment** and using that as the radial coordinate for the Gerstner wave. This produces a smooth, continuous wavefront along the chain rather than overlapping circles.

At the tail end of the chain, the last point has no next neighbor and degenerates to a circular wavelet — which is correct, since that's where the wake trail ends.

The interpolation along each segment also blends parameters: a point near the head uses newer amplitude/age, a point near the tail uses older values. This gives smooth amplitude fadeout along the wake trail.

This design eliminates the need for cross-entity references, index resolution, or sorting. Each chain modifier is self-contained — it manages its own points, writes them contiguously, and the GPU processes segments sequentially.

### Wave Computation

For each query point (screen pixel or physics sample), the shader:

1. For each disturbance particle (or linked segment):
   - Compute distance `d` to the particle (or nearest point on segment)
   - The expanding wavefront is at radius `r(t) = initialRadius + √(g·λ/2π) · age` (deep-water group velocity)
   - Compute Gerstner displacement at `d` relative to the wavefront:
     - Horizontal displacement: `Q · A · cos(k·(d - r(t)))` (radially outward)
     - Vertical displacement: `A · sin(k·(d - r(t)))` where `k = 2π/λ`
   - Amplitude decays as `A₀ · e^(-decayRate · age) / √(max(d, 1))` (energy spreading + time decay)
   - Only contribute within a few wavelengths of the wavefront (avoid computing the entire expanding disc)
2. Sum all contributions (height is additive, turbulence takes max)

### Turbulence / Foam

Two sources:

1. **Emergent**: Where Gerstner horizontal displacements converge (negative Jacobian), water piles up — this naturally produces foam at wave crests and interference zones. This is computed from the sum of all horizontal displacements.
2. **Explicit**: The per-particle `turbulence` float, used for stern churn and splashes. Decays with age. Contributes directly to the foam channel.

### Boat Emission Strategy

Three emission points on the boat:

1. **Port bow** — wake polyline chain. Emits when boat has traveled ~1.3 ft. Low turbulence, moderate amplitude, high steepness. Links to previous port particle.
2. **Starboard bow** — mirror of port. Separate chain.
3. **Stern center** — turbulence particles. Emits at same interval. High initial turbulence, lower amplitude, short wavelength, `initialRadius` = half stern width. These can be standalone (unlinked) or form their own short chain.

All particles are stationary after spawn. No outward velocity.

### Other Disturbance Types

The same particle system handles:

- **Anchor splash** — single unlinked particle, high amplitude, fast decay, high initial turbulence
- **Oar strokes** — short linked chains, medium amplitude
- **Future: shore reflections, buoy bobbing, etc.**

The existing `AnchorSplashRipple` would be migrated to use this system.

---

## Current State

### Files involved in the current wake system:

- `src/game/boat/Wake.ts` — Spawns `WakeParticle` entities on port/starboard sides, maintains linked chains
- `src/game/boat/WakeParticle.ts` — Individual particle entity extending `WaterModifier`. Moves outward, decays, exports capsule SDF data to GPU
- `src/game/world/water/WaterModifierBase.ts` — Abstract `WaterModifier` base class, `GPUWaterModifierData` types, `WaterModifierType` enum
- `src/game/world/water/WaterResources.ts` — Collects all `"waterModifier"` tagged entities, packs into `modifiersBuffer` (14 floats/modifier), uploads to GPU
- `src/game/world/shaders/water-modifiers.wgsl.ts` — WGSL shader functions: `computeWakeContribution` (capsule SDF + cos ripple), `calculateModifiers` (accumulator loop)
- `src/game/boat/AnchorSplashRipple.ts` — Separate `WaterModifier` for anchor splash (uses Ripple type)
- `src/game/boat/Boat.ts:142` — Creates `Wake` with stern points from hull geometry

### Current approach limitations:

- Particles move outward (incorrect physics — water doesn't move, waves propagate)
- Uses `cos(dist)` for ripple pattern instead of proper Gerstner waves
- No steepness control (pure sinusoidal, not peaked crests)
- Capsule SDF produces uniform height across the segment width rather than an expanding wavefront
- Turbulence is just `rawIntensity * falloff²` — no emergent foam from wave convergence
- Each WakeParticle is a full game entity (entity overhead per particle)

---

## Desired Changes

### Architecture: Chain Modifier Entity

Each `WaterModifier` entity owns an entire chain of disturbance points. Instead of one entity per particle, we have one entity per chain (e.g., port wake = 1 entity with ~50 points). The entity:

- Maintains an internal array of `DisturbancePoint` structs (position, amplitude, age, etc.)
- Appends new points at the head on each spawn tick
- Trims expired points from the tail
- Exports all points contiguously to the GPU buffer via `getGPUModifierData()`
- Computes its own AABB as the union of all point influence radii

This replaces both `WakeParticle` (individual entity per particle) and `Wake` (spawner that manages chains of particle entities). A single `WakeModifier` entity handles both roles.

### GPU Buffer Layout

Keep the existing modifier buffer system. Each chain modifier exports a **variable number of points** into the buffer. The modifier header includes a point count, and the shader processes points as sequential segments.

Per-point data in the buffer — 8 floats per point:

| Slot | Field         | Description                                      |
| ---- | ------------- | ------------------------------------------------ |
| 0    | posX          | World position X (ft)                            |
| 1    | posY          | World position Y (ft)                            |
| 2    | amplitude     | Current amplitude (ft), pre-decayed on CPU       |
| 3    | wavelength    | Wavelength (ft)                                  |
| 4    | steepness     | Gerstner Q (0-1)                                 |
| 5    | age           | Seconds since spawn                              |
| 6    | initialRadius | Starting expansion radius (ft)                   |
| 7    | turbulence    | Current foam intensity (0-1), pre-decayed on CPU |

The modifier header (already using slots 0-4 for type + AABB) would include the point count and a `decayRate` shared across the chain. The shader iterates adjacent pairs of points as segments.

Since chains are variable-length, the packing in `WaterResources` needs to handle variable-stride modifiers. Options:
- **Separate buffer**: A dedicated disturbance point buffer alongside the existing modifier buffer. The modifier buffer entry just has a type + AABB + offset + count into the point buffer.
- **Inline in modifier buffer**: Each chain writes its header + N points directly into the modifier buffer, consuming `headerSize + N * pointSize` floats. Other modifier types (Ripple, Current) still use fixed stride.

**Recommendation**: Separate buffer. The existing modifier buffer keeps its fixed 14-float stride for Ripple/Current/Obstacle. Wake modifiers write their point data to a new `disturbancePointBuffer`. The modifier buffer entry for a Wake just stores an offset and count into the point buffer. The shader reads the point buffer for Wake types. This avoids complicating the fixed-stride modifier buffer with variable-length entries.

---

## Files to Modify

### New files:

- `src/game/world/water/DisturbanceChain.ts` — **New**. The chain modifier entity that replaces both `Wake` and `WakeParticle`. Extends `WaterModifier`. Contains:
  - `DisturbancePoint` struct (position, amplitude, wavelength, steepness, age, initialRadius, turbulence)
  - Internal array of points, with push/trim operations
  - `getGPUModifierData()` that exports point count + offset into the disturbance buffer
  - A new `getDisturbancePoints()` method that returns the point array for `WaterResources` to pack into the dedicated buffer
  - AABB computation from all active points

### Modified files:

- `src/game/boat/Wake.ts` — **Rewrite**. Instead of spawning `WakeParticle` entities, creates and owns three `DisturbanceChain` entities (port bow, starboard bow, stern center). On each tick, appends a new point to the relevant chains based on boat speed/position. Sets Gerstner parameters per point based on boat speed.

- `src/game/world/water/WaterModifierBase.ts` — Update `WakeModifierData` to carry an offset + count into the disturbance point buffer (instead of capsule params). Add the `DisturbancePointData` type definition.

- `src/game/world/water/WaterResources.ts` — Add a second GPU buffer (`disturbancePointBuffer`) for chain point data. In the collection step, iterate Wake modifiers and pack their point arrays contiguously into this buffer. Upload both buffers. Track the total point count for the shader uniform.

- `src/game/world/shaders/water-modifiers.wgsl.ts` — **Major rewrite** of `computeWakeContribution`. New version:
  - Reads offset + count from the modifier buffer entry
  - Iterates segments (adjacent point pairs) in the disturbance point buffer
  - For each segment: distance-to-line-segment, expanding Gerstner wavelet, parameter interpolation along segment
  - Amplitude decay with distance from wavefront
  - Explicit turbulence from per-point turbulence field
  - Emergent turbulence from horizontal displacement convergence

- `src/game/boat/Boat.ts` — Update `Wake` constructor. Pass bow points in addition to stern points. May need `findBowPoints()`.

- `src/game/boat/Hull.ts` — Add `findBowPoints()` function.

### Files to delete:

- `src/game/boat/WakeParticle.ts` — Replaced by `DisturbanceChain`

### Unchanged:

- `src/game/boat/AnchorSplashRipple.ts` — Keeps using Ripple modifier type. Can migrate later.

### Shaders that bind the modifier buffer (need disturbance point buffer added to bind group):

- `src/game/surface-rendering/WaterHeightShader.ts` — Add `disturbancePointBuffer` to bind group
- `src/game/world/water/WaterQueryShader.ts` — Add `disturbancePointBuffer` to bind group

---

## Execution Order

### Phase 1: Data types + GPU plumbing

1. Update `WaterModifierBase.ts` — new `WakeModifierData` (offset + count), `DisturbancePointData` type
2. Create `DisturbanceChain.ts` — chain entity with point management and export methods
3. Update `WaterResources.ts` — add `disturbancePointBuffer`, pack chain points contiguously, track offsets

### Phase 2: Shader (depends on Phase 1)

4. Rewrite `computeWakeContribution` in `water-modifiers.wgsl.ts` — segment iteration, Gerstner wavelet, turbulence
5. Update `WaterHeightShader.ts` and `WaterQueryShader.ts` — add disturbance point buffer to bind groups

### Phase 3: Boat integration (depends on Phase 1)

6. Add `findBowPoints()` to `Hull.ts`
7. Rewrite `Wake.ts` — create `DisturbanceChain` children, emit points on tick
8. Update `Boat.ts` — pass bow + stern points to Wake
9. Delete `WakeParticle.ts`

### Phase 4: Tuning + Polish (depends on Phases 2 & 3)

10. Tune parameters — wavelength, steepness, decay rates, spawn intervals
11. Verify physics queries still work correctly (water height from wakes affects buoyancy)
12. Consider migrating `AnchorSplashRipple` to the new system

---

## Open Questions

1. **Wavefront thickness**: A single expanding Gerstner ring is infinitely thin. In practice we want the disturbance to affect a region a few wavelengths wide around the wavefront. We should evaluate the Gerstner wave for distances within `[r(t) - 2λ, r(t) + λ]` and let it naturally decay outside that window via the sinusoidal envelope.

2. **Performance**: The shader now iterates segments within each chain rather than individual modifiers. With ~3 chains and ~50 points each, plus AABB culling at the chain level, this should be comparable to or better than the current per-particle approach. The Gerstner math per segment is slightly more expensive than the current cos ripple but not dramatically so.

3. **Disturbance point buffer sizing**: Need to pick a max total point count for the buffer. 1024 points (8 floats each = 32KB) is generous and cheap.
