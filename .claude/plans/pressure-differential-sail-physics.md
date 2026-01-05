# Pressure-Differential Sail Physics

## Overview

Replace the current empirical lift/drag coefficient model with an emergent pressure-differential system where sail forces arise naturally from wind velocity differences on either side of the sail.

**Core principle**: Bernoulli's equation tells us that faster-moving air has lower pressure. Sails generate lift by making air flow faster on the leeward (curved) side than the windward (blocked) side. The pressure differential creates a net force pushing the sail from high pressure to low pressure.

---

## Current Architecture

### Force Calculation (`Sail.ts` + `sail-helpers.ts`)
```
For each sail node:
  1. Calculate local camber from neighboring nodes
  2. Calculate angle of attack (wind vs sail tangent)
  3. Look up empirical lift coefficient: Cl = f(AoA, camber)
  4. Apply lift force perpendicular to wind
  5. Apply drag force parallel to wind
```

### Wind Modification (`SailWindEffect.ts`)
```
For each query point:
  1. Determine if point is leeward, windward, or in wake
  2. Add velocity contribution based on zone:
     - Leeward: accelerate flow along sail
     - Windward: decelerate/block flow
     - Wake: reduce wind behind stalled sections
```

### Problems with Current Approach
1. **Double-counting**: Lift coefficients and wind modifications model the same circulation
2. **Empirical tuning**: Cl curves are educated guesses, not emergent
3. **Decoupled systems**: Force calc and wind modification don't inform each other
4. **Stall is prescribed**: We check angle thresholds rather than detecting flow separation

---

## Proposed Architecture

### Core Concept

Instead of looking up lift coefficients, **sample the wind velocity on both sides of the sail** and compute force from the pressure differential:

```
For each sail segment:
  1. Sample wind velocity at leeward offset point
  2. Sample wind velocity at windward offset point
  3. Compute pressures using Bernoulli: P = P0 - 0.5 * rho * v^2
  4. Pressure differential: dP = P_windward - P_leeward
  5. Force = dP * segment_area * normal_direction
```

### Why This Works

The `SailWindEffect` already modifies wind to be faster on the leeward side (LEEWARD_ACCELERATION) and slower on the windward side (WINDWARD_BLOCKAGE). If we tune these correctly:

- **Lift emerges**: Leeward air is faster → lower pressure → net force toward leeward
- **Slot effect emerges**: Jib accelerates air that the mainsail samples on its leeward side
- **Stall emerges**: When flow separates, leeward acceleration disappears, pressure differential collapses
- **Drag emerges**: Windward blockage creates high pressure zone pushing backward

---

## Implementation Plan

### Phase 1: Preparation and Measurement

**Goal**: Understand current behavior before changing anything.

1. **Add performance instrumentation**
   - Count wind queries per frame
   - Measure time in force calculation vs wind modification
   - Establish baseline FPS with current system

2. **Add force visualization**
   - Draw force vectors on sail nodes
   - Show pressure sample points
   - Visualize wind velocity field around sails

3. **Document current behavior**
   - Record typical lift/drag forces in various conditions
   - Note how sails behave in different points of sail
   - Capture stall behavior characteristics

### Phase 2: Wind Field Refinement

**Goal**: Make wind modifications produce physically meaningful velocity fields.

1. **Review wind modification physics**
   - Current LEEWARD_ACCELERATION = 0.15 (15% speedup)
   - Current WINDWARD_BLOCKAGE = 0.1 (10% slowdown)
   - These may need significant retuning

2. **Add circulation-based wind modification**
   - Real sail circulation creates a velocity field that falls off with distance
   - Consider using potential flow theory for more accurate velocity field
   - The velocity difference should be proportional to lift (not the other way around)

3. **Handle sail curvature properly**
   - More camber = more circulation = bigger velocity differential
   - Curvature should directly influence wind modification strength

4. **Improve stall modeling in wind modification**
   - When angle of attack is too high, flow separates
   - Leeward acceleration should diminish/reverse
   - Wake turbulence should increase

### Phase 3: Pressure Sampling System

**Goal**: Create robust infrastructure for sampling wind at offset points.

1. **Define sample point geometry**
   ```typescript
   interface PressureSamplePoints {
     leeward: V2d;   // Offset from segment in leeward normal direction
     windward: V2d;  // Offset from segment in windward normal direction
   }

   function getSamplePoints(
     segmentPosition: V2d,
     segmentNormal: V2d,  // Points to leeward side
     sampleDistance: number
   ): PressureSamplePoints
   ```

2. **Choose sample distance carefully**
   - Too close: numerical noise, possibly inside the "sail" conceptually
   - Too far: misses the velocity differential, samples ambient wind
   - Likely want 1-5 units offset (tunable)
   - May want different distances for leeward vs windward

3. **Handle edge cases**
   - Sample points at head/clew (edge of sail)
   - Sample points that might be inside another sail
   - Sample points outside world bounds

### Phase 4: Force Calculation Rewrite

**Goal**: Replace empirical lift/drag with pressure-differential forces.

1. **New force calculation loop**
   ```typescript
   // In Sail.onTick()
   for (let i = 0; i < segments; i++) {
     const segment = this.getSegmentGeometry(i);

     // Sample wind on both sides
     const leewardWind = wind.getVelocityAtPoint(segment.leewardSample, this.windEffect);
     const windwardWind = wind.getVelocityAtPoint(segment.windwardSample, this.windEffect);

     // Compute pressure differential (Bernoulli)
     const leewardSpeed = leewardWind.magnitude;
     const windwardSpeed = windwardWind.magnitude;
     const pressureDiff = 0.5 * AIR_DENSITY * (windwardSpeed * windwardSpeed - leewardSpeed * leewardSpeed);

     // Apply force
     const force = segment.normal.mul(pressureDiff * segment.area);
     segment.body.applyForce(force);
   }
   ```

2. **Remove empirical lift/drag**
   - Delete or deprecate `getSailLiftCoefficient()`, `sailLift()`, `sailDrag()`
   - Remove `applyFluidForces()` calls for sails
   - Keep these for other uses (rudder, hull) if needed

3. **Add minimal drag component**
   - Pressure differential gives lift-like force
   - May need small explicit drag for energy dissipation
   - Or drag emerges from windward pressure zone

### Phase 5: Self-Interaction and Ordering

**Goal**: Handle the circular dependency between sails modifying wind and sampling it.

1. **Establish update order**
   ```
   Option A: Two-pass per frame
     1. All sails update their wind modifications (based on previous frame geometry)
     2. All sails sample wind and compute forces

   Option B: Exclude self, include others
     1. Each sail samples wind excluding its own modification
     2. Other sails' modifications affect this sail
     3. This is what we do now with skipModifier

   Option C: Lagged self-effect
     1. Sail samples wind including its own PREVIOUS frame's modification
     2. Introduces one-frame delay but may be more stable
   ```

2. **Cross-sail interactions**
   - Jib's wind modification SHOULD affect mainsail (slot effect)
   - This should work with Option B (skip self, include others)
   - Need to verify spatial hash returns other sails' effects

3. **Turbulence particles**
   - Should these affect the sail that spawned them? Probably yes
   - They drift downwind, so might affect aft sections of same sail
   - Keep them as separate WindModifiers, don't skip

### Phase 6: Tuning and Stability

**Goal**: Make the system behave realistically without oscillation.

1. **Damping**
   - Pressure forces could cause oscillation without damping
   - Options:
     - Velocity-based damping on sail particles
     - Time-averaging of pressure samples
     - Limit rate of force change per frame

2. **Parameter tuning**
   ```typescript
   // Key parameters to tune:
   const AIR_DENSITY = 1.225;           // kg/m³ at sea level
   const SAMPLE_DISTANCE = 2.0;         // Units from sail surface
   const LEEWARD_ACCELERATION = ???;    // Needs retuning for pressure system
   const WINDWARD_BLOCKAGE = ???;       // Needs retuning for pressure system
   const FORCE_SCALE = ???;             // Overall force multiplier
   ```

3. **Stall behavior tuning**
   - At high angles of attack, leeward flow should separate
   - Wind modification should detect this and reduce/eliminate acceleration
   - Pressure differential should collapse naturally

4. **Validation against real sailing**
   - Boat should point ~45° to wind (not higher, not lower)
   - Slot effect should allow tighter pointing
   - Stalled sails should flutter and lose power
   - Running downwind should work (low differential, mostly drag)

### Phase 7: Performance Optimization

**Goal**: Achieve acceptable frame rate with the new system.

1. **Measure new query load**
   - Old: 1 wind query per sail node (for velocity at node)
   - New: 2 wind queries per sail segment (leeward + windward samples)
   - Roughly 2x more wind queries

2. **Optimization strategies**
   - Sample fewer segments (every 2nd or 3rd node)
   - Cache sample results within frame (if same point queried multiple times)
   - Simplify wind modification for distant sails
   - Use LOD for AI boats far from player

3. **Spatial hash tuning**
   - Current cell size may not be optimal for new query pattern
   - Profile and adjust

### Phase 8: Cleanup and Polish

1. **Remove dead code**
   - Empirical lift/drag functions (if fully replaced)
   - Turbulence particle system (if stall emerges naturally)
   - Or keep turbulence for visual effect only

2. **Documentation**
   - Document the physics model
   - Document tuning parameters
   - Add comments explaining the Bernoulli relationship

3. **Visual polish**
   - Sail rendering might need adjustment for new behavior
   - Luffing animation should emerge from physics
   - Tell-tails should react to local flow

---

## Key Risks and Mitigations

### Risk: Numerical Instability
- **Symptom**: Sails oscillate wildly, forces explode
- **Mitigation**: Add damping, clamp force magnitudes, use temporal smoothing

### Risk: Poor Performance
- **Symptom**: FPS drops significantly with new sampling
- **Mitigation**: Profile early, optimize spatial hash, reduce sample count

### Risk: Unrealistic Behavior
- **Symptom**: Boat won't point to wind, or points too high, or sails don't stall
- **Mitigation**: Start with known-good wind modification values, tune incrementally

### Risk: Self-Reference Feedback
- **Symptom**: Sail's own modification causes runaway force increase
- **Mitigation**: Use self-skip, or careful update ordering, or lagged self-effect

### Risk: Lost Functionality
- **Symptom**: Current sailing feel is destroyed, game becomes unplayable
- **Mitigation**: Implement on branch, keep old system available, A/B compare

---

## Open Questions

1. **Sample distance**: What's the right offset from the sail surface? Too close = noise, too far = no differential. May need to experiment.

2. **Stall detection**: Do we still need explicit stall detection for wind modification, or can it emerge from the angle between wind and sail?

3. **Turbulence role**: Is turbulence still needed? If stall causes leeward flow to slow/reverse, pressure differential handles it. Turbulence might be purely visual.

4. **Drag modeling**: Does all drag emerge from pressure, or do we need explicit skin friction / form drag?

5. **3D effects**: Real sails have twist (different angle at different heights). Our 2D model ignores this - is that okay?

6. **Apparent wind**: Boat motion creates apparent wind. Currently handled by querying wind at boat position. Does this interact well with pressure sampling?

---

## Success Criteria

1. **Emergent lift**: Sail generates lift without empirical Cl lookup
2. **Emergent stall**: At high AoA, lift collapses without explicit threshold check
3. **Slot effect**: Jib measurably improves mainsail performance
4. **Reasonable performance**: <5% FPS regression from current system
5. **Sailing feel**: Boat sails realistically - points to wind, tacks, gybes, heels
6. **Code simplicity**: Net reduction in sail physics complexity

---

## Estimated Scope

This is a significant architectural change. Rough estimates:

- **Phase 1** (Preparation): 1-2 hours
- **Phase 2** (Wind Field): 2-4 hours
- **Phase 3** (Pressure Sampling): 1-2 hours
- **Phase 4** (Force Rewrite): 2-3 hours
- **Phase 5** (Self-Interaction): 1-2 hours
- **Phase 6** (Tuning): 3-6 hours (highly variable)
- **Phase 7** (Performance): 1-3 hours
- **Phase 8** (Cleanup): 1-2 hours

**Total**: Roughly 12-24 hours of focused work, with tuning being the wildcard.

Recommend implementing on a feature branch with frequent commits so we can bisect if something breaks.
