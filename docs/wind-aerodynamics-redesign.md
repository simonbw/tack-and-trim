# Wind & Aerodynamics System Redesign Analysis

## Executive Summary

After thoroughly analyzing the current wind and sail systems, I believe the core abstractions (Sail with nodes, Wind, WindModifiers) are **fundamentally sound** but the aerodynamic calculations need significant revision. The current implementation has some structural issues that prevent the emergent behaviors you want. Below I analyze each phenomenon you want, assess the current system's capability, and propose improvements.

---

## Current System Assessment

### What's Working Well

1. **GPU-accelerated wind field** - The tile-based computation with CPU fallback is elegant and performant
2. **Per-segment sail structure** - Having 32 particles per sail gives good granularity for local effects
3. **Wind modifier architecture** - The spatial hash and AABB-based querying is efficient
4. **Physics foundation** - Using proper lift/drag formulas with correct units

### Core Problems

1. **SailWindEffect uses aggregate state** - Currently computes a single centroid, average lift coefficient, and stall fraction for the whole sail. This loses the per-segment detail needed for slot effects and proper wind shadow.

2. **Zone-based wind modification is too coarse** - The current "leeward zone / windward zone / wake zone" approach with hard thresholds (>0.3, <-0.3) doesn't capture the nuanced flow patterns around a sail.

3. **Camber is computed but not used** - The camber calculation exists but the lift factor is set to 0.

4. **No pressure modeling** - The system only tracks velocity, but sail-sail interaction (slot effect) is fundamentally about pressure differentials creating acceleration.

5. **Stall is binary** - 15° threshold with no hysteresis or gradual transition.

---

## Phenomenon-by-Phenomenon Analysis

### 1. Parachute Forces (Wind Blowing Into Sail)

**Current state**: Partially implemented via drag coefficient, but the drag model doesn't distinguish between form drag (parachute) and friction drag.

**What's needed**: When angle of attack approaches 90°, the sail should act primarily as a drag device. The current drag formula (`0.02 + 0.1*α² + stall_penalty`) doesn't capture this well.

**Recommendation**: Replace with a proper polar curve that handles the full 0-180° range:
```
Cd = Cd0 + Cd_induced(α) + Cd_form(α)
where Cd_form = Cd_max * sin²(α)  // peaks at 90°
```

### 2. Lift Forces from Proper Camber

**Current state**: Camber is calculated per-segment (3-point geometry) but the camber factor in lift calculation is 0.

**What's needed**: Enable and tune the camber factor. A properly cambered sail generates more lift than a flat plate at the same angle of attack.

**Recommendation**:
- Enable camber lift factor: `Cl = Cl_base * (1 + camberFactor * camber)`
- Typical camber lift factor: 0.5-1.0
- This will naturally reward proper sail trim

### 3. Luffing (Sail Facing Too Close to Wind)

**Current state**: Not explicitly modeled. The sail particles will flutter when forces are low, but there's no explicit luffing detection or behavior.

**What's needed**: When the angle of attack is very small (<5°) or negative, the sail should lose tension and flutter. This is actually a **constraint problem** more than an aerodynamic problem.

**Recommendation**:
- Detect luffing condition: `|α| < luff_threshold` (e.g., 5°)
- When luffing, reduce constraint stiffness and increase particle randomization
- Add visual/audio feedback (sail texture flutter, flapping sound)
- Particles should be allowed to "fold back" rather than maintaining sail shape

### 4. Stall (High Angle of Attack)

**Current state**: Binary stall at 15° with exponential lift decay. No hysteresis.

**What's needed**: Gradual stall onset, hysteresis, and more realistic post-stall behavior.

**Recommendation**:
```
Stall entry: α > 15°
Stall recovery: α < 12° (hysteresis prevents oscillation)

Pre-stall:  Cl = 2π * sin(α)
Transition: Cl = smooth_step between pre-stall and post-stall
Post-stall: Cl = 0.8 * sin(2α)  // peaks around 45°, goes to 0 at 90°
```

### 5. Sail-Sail Interaction (Slot Effect, Wind Stealing)

**Current state**: SailWindEffect creates acceleration in the leeward zone, which should theoretically create slot effect. However, because it uses aggregate sail state, the jib's leeward acceleration zone is computed from its centroid, not per-segment.

**What's needed**: Per-segment wind modification, not aggregate. The slot effect occurs because the jib's trailing edge accelerates flow onto the mainsail's leading edge.

**This is the most important fix.** See detailed proposal below.

### 6. Boat-to-Boat Wind Effects

**Current state**: Should work if sails from multiple boats are all registered as wind modifiers. The spatial hash and GPU computation don't distinguish boat ownership.

**What's needed**: Longer-range wake effects. Current wake extends only 3× chord length (~15-20 ft). A boat's wind shadow can extend hundreds of feet downwind.

**Recommendation**: Add a boat-level wind modifier (not just sail-level) that creates a longer-range downwind shadow based on the boat's overall cross-section to the wind.

---

## The Core Question: Is Per-Segment Wind Modification Enough?

### Option A: Enhanced Per-Segment Modifiers (Recommended)

Keep the current architecture but make each sail segment a separate wind modifier contribution.

**Changes needed**:
1. **SailWindEffect** computes and uploads per-segment state to GPU (not aggregate)
2. GPU shader iterates over segments (32 per sail × max 16 sails = 512 segments)
3. Each segment creates its own small acceleration/deceleration zone

**Pros**:
- Maintains current architecture
- GPU can handle 512 segments efficiently
- Enables true slot effect emergence
- Computationally tractable

**Cons**:
- More data to upload per frame (512 × ~32 bytes = 16KB)
- Shader complexity increases

**GPU Data Format**:
```typescript
interface GPUSailSegmentData {  // 8 floats = 32 bytes
  position: [x, y]
  tangent: [x, y]
  normal: [x, y]
  length: number
  liftCoefficient: number
}
```

### Option B: Pressure Field + Velocity Field

Store both pressure and velocity at each point in the wind field.

**How it works**:
- Sails create low-pressure zones on their leeward side (Bernoulli principle)
- Wind accelerates from high to low pressure
- Pressure naturally propagates and creates realistic flow patterns

**Implementation**:
1. Wind field becomes rgba16float: (velocity.x, velocity.y, pressure, turbulence)
2. Each frame: compute pressure from sail geometry, then derive velocity from pressure gradients
3. Requires solving (simplified) Navier-Stokes

**Pros**:
- Most physically accurate
- Slot effect, wind stealing, boat shadows all emerge naturally
- Pressure gradients create correct acceleration patterns

**Cons**:
- Significantly more complex
- Requires iterative pressure solver (multiple GPU passes)
- May be overkill for a game

### Option C: Particle-Based Simulation (Lagrangian)

Simulate individual wind "packets" that interact with sails.

**How it works**:
- Spawn wind particles upwind
- Particles advect with base wind
- Sails deflect/accelerate/block particles
- Query wind by sampling nearby particles

**Pros**:
- Very intuitive
- Natural handling of wake turbulence
- Visually debuggable

**Cons**:
- Expensive (need thousands of particles for smooth field)
- Sparse queries are unreliable
- Hard to parallelize efficiently
- SPH-style fluid sim is complex to tune

### Option D: Hybrid Streamline Model

Pre-compute streamlines through sail geometry and use them to guide wind modification.

**How it works**:
- When sail geometry changes, compute a few streamlines through the slot
- Store streamline paths as splines
- Wind modification queries interpolate between streamlines

**Pros**:
- Captures slot effect geometry explicitly
- Relatively cheap per-frame cost

**Cons**:
- Complex streamline computation
- Doesn't handle turbulence well
- Becomes complicated with many sails

---

## My Recommendation

**Start with Option A (Enhanced Per-Segment Modifiers)**, with one addition from Option B: **add turbulence as a scalar field**.

### Proposed Wind State

```typescript
// Per-point wind state (rgba16float texture)
interface WindState {
  velocityX: number      // ft/s
  velocityY: number      // ft/s
  turbulence: number     // 0-1, affects force randomization
  // Fourth channel reserved for future (pressure, temperature, etc.)
}
```

### Why Turbulence Matters

Instead of spawning discrete turbulence particles, treat turbulence as a field:
- Stalled sails increase turbulence in their wake
- Turbulence diffuses and decays over time
- When applying forces, add random variation scaled by local turbulence
- This is cheaper and smoother than discrete particles

### Implementation Roadmap

1. **Phase 1: Fix SailWindEffect to be per-segment**
   - Upload per-segment data instead of aggregate
   - Modify GPU shader to iterate segments
   - Test slot effect emergence

2. **Phase 2: Improve aerodynamic curves**
   - Enable camber factor
   - Fix drag formula for full α range
   - Add stall hysteresis

3. **Phase 3: Add turbulence field**
   - Extend wind texture to rgba16float
   - Compute turbulence from stalled segments
   - Add turbulence diffusion/decay pass
   - Use turbulence in force application

4. **Phase 4: Add luffing behavior**
   - Detect luffing condition
   - Modify constraint behavior
   - Add visual/audio feedback

5. **Phase 5: Long-range boat shadows (optional)**
   - Add boat-level wind modifier
   - Longer-range downwind shadow zone

---

## Answering Your Specific Questions

### Q1: Are current abstractions (Sail with nodes, Wind, WindModifiers) good enough?

**Yes, with modifications.** The abstractions are sound. The issues are:
- SailWindEffect needs per-segment granularity
- Need to store turbulence in wind field
- Aerodynamic coefficient curves need tuning

### Q2: Should we simulate individual wind particles?

**No, not recommended.** Particle simulation (Lagrangian) is expensive and hard to query smoothly. The Eulerian approach (grid-based field) you have is better for this use case. GPU compute shaders handle fields much better than scattered particles.

That said, you could consider a **small number of tracer particles** purely for visualization/debugging of the wind field - but don't use them for actual force computation.

### Q3: What additional wind state beyond velocity?

**Turbulence is the main addition.** Pressure would enable more physically accurate simulation but adds significant complexity. I'd recommend:

- **Definitely add**: Turbulence (scalar, 0-1)
- **Consider later**: Pressure (for Navier-Stokes style simulation)
- **Not needed**: Temperature, humidity, etc.

---

## Technical Details for Per-Segment Implementation

### GPU Shader Changes

Current shader loops over sails (max 16):
```wgsl
for (var i = 0u; i < sailCount; i++) {
    contribution += getSailContribution(worldX, worldY, i);
}
```

Proposed shader loops over segments:
```wgsl
for (var sailIdx = 0u; sailIdx < sailCount; sailIdx++) {
    let segmentStart = sailIdx * SEGMENTS_PER_SAIL;
    for (var segIdx = 0u; segIdx < SEGMENTS_PER_SAIL; segIdx++) {
        contribution += getSegmentContribution(worldX, worldY, segmentStart + segIdx);
    }
}
```

### Per-Segment Wind Effect Model

Each segment creates:

1. **Circulation effect** (primary): Air accelerates around the segment from windward to leeward
   - Creates acceleration perpendicular to segment, scaled by lift coefficient
   - Effect radius: ~2-3× segment length

2. **Wake deficit**: Downwind of segment, velocity is reduced
   - Scales with drag coefficient
   - Wake width: ~segment length
   - Wake length: ~3× segment length (longer if stalled)

3. **Turbulence injection**: Stalled segments add turbulence to wake
   - Turbulence = f(stall_severity, velocity)
   - Spreads and decays over time

### Slot Effect Emergence

With per-segment modifiers:
1. Jib's trailing edge segments create leeward acceleration
2. This acceleration zone overlaps with mainsail's leading edge
3. Mainsail sees increased apparent wind velocity
4. Mainsail generates more lift

**Key tuning parameters**:
- Circulation strength (how much does each segment accelerate leeward flow?)
- Effect radius (how far does the acceleration extend?)
- Interaction threshold (minimum lift coefficient to create circulation)

---

## Summary

| Phenomenon | Current Status | Fix Required |
|------------|----------------|--------------|
| Parachute forces | Partial | Improve drag curve |
| Lift from camber | Disabled | Enable camber factor |
| Luffing | Not modeled | Add detection + behavior |
| Stall | Binary | Add hysteresis, gradual transition |
| Slot effect | Broken (aggregate) | Per-segment wind modifiers |
| Boat shadows | Very short range | Add boat-level modifier |

The current system is ~60% of the way there. The biggest single improvement would be **making SailWindEffect per-segment instead of aggregate** - this will unlock slot effect and wind stealing naturally.
