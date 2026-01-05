# Gameplan: Per-Node Directional Sail Wind Effects with Propagating Turbulence

## Overview

Replace the current single-point, symmetric wind modifier with a per-segment directional model that creates realistic wind disturbances. Add propagating turbulence particles that spawn from stalled sail segments and drift downwind.

---

## Current State

### Wind System (`src/game/Wind.ts`)
- `Wind` entity maintains a `Set<WindModifier>`
- `getVelocityAtPoint(point)` iterates all modifiers, sums contributions
- `getBaseVelocityAtPoint(point)` returns noise-varied base wind without modifiers
- Simple distance-squared check for early-out on influence radius

### WindModifier Interface (`src/game/WindModifier.ts`)
- `getWindModifierPosition()` - center point for distance checks
- `getWindModifierInfluenceRadius()` - max influence distance
- `getWindVelocityContribution(queryPoint)` - velocity delta to add

### Sail Wind Modifier (`src/game/boat/Sail.ts:269-364`)
Current implementation:
- **Single point**: Uses `windModifierPosition` at 1/3 along chord (line 286)
- **Single lift coefficient**: Calculated from middle particle only (lines 299-310)
- **Binary stall**: Whole sail is stalled or not (line 311)
- **Symmetric circulation**: Tangential flow around single point, same in all directions (lines 344-353)
- **Random turbulence**: When stalled, adds uniform random noise (lines 355-361)

### Sail Physics (`src/game/boat/Sail.ts:223-267`)
Force application already works per-node:
- Iterates all bodies (particles)
- Calculates local camber per node
- Applies lift/drag forces per segment
- Uses `wind.getVelocityAtPoint()` for each node

### Aerodynamic Helpers (`src/game/boat/sail-helpers.ts`)
- `calculateCamber(prev, current, next)` - local curvature
- `getSailLiftCoefficient(angleOfAttack, camber)` - Cl with stall
- `isSailStalled(angleOfAttack)` - stall detection
- `STALL_ANGLE = 15°`

---

## Desired Changes

### 1. Per-Segment Directional Wind Effects
Each sail segment (edge between adjacent nodes) contributes to the wind field based on:
- Its local orientation and camber
- Its local angle of attack and stall state
- The query point's position relative to the segment (leeward vs windward vs downwind)

### 2. Asymmetric Influence Zones
Different effects based on which side of the sail the query point is on:
- **Leeward (convex side)**: Accelerated flow parallel to surface
- **Windward (concave side)**: Decelerated flow, some blockage
- **Downwind wake**: Reduced velocity extending in wind direction

### 3. Propagating Turbulence Particles
Instead of instant random noise:
- Stalled segments spawn `TurbulenceParticle` entities
- Particles drift with local wind velocity
- Particles fade over time/distance
- Each particle is a small WindModifier adding chaotic velocity

### 4. Sail-on-Sail Interaction
- Jib's wind effects naturally affect mainsail through existing wind queries
- Intra-sail effects: upstream segments affect downstream segments (1-tick delay acceptable)

---

## New Types & Entities

### `SailSegmentState` (internal to Sail)
```typescript
interface SailSegmentState {
  position: V2d;        // Segment midpoint
  normal: V2d;          // Perpendicular to segment, pointing to leeward side
  tangent: V2d;         // Along segment (head to clew direction)
  length: number;       // Segment length
  liftCoefficient: number;
  isStalled: boolean;
  camber: number;
}
```

### `TurbulenceParticle` (new entity)
```typescript
class TurbulenceParticle extends BaseEntity implements WindModifier {
  position: V2d;
  velocity: V2d;        // Inherited from wind at spawn
  intensity: number;    // Starts at 1.0, decays over time
  age: number;          // Time since spawn
  maxAge: number;       // ~1-2 seconds
  radius: number;       // Influence radius, fairly small (~5-10 units)
}
```

---

## Files to Modify

### `src/game/boat/Sail.ts`
- Add `segmentStates: SailSegmentState[]` array
- Refactor `updateWindModifierState()` to compute per-segment state
- Refactor `getWindVelocityContribution()` to:
  - Iterate segments
  - For each segment, determine query point's zone (leeward/windward/downwind)
  - Compute directional contribution
  - Sum all segment contributions
- Add `spawnTurbulence()` method called when segments transition to stalled
- Track previous stall state per segment to detect transitions
- Remove `STALL_TURBULENCE_SCALE` random noise (replaced by particles)

### `src/game/boat/sail-helpers.ts`
- Add `getSegmentWindContribution(segment, queryPoint, windDirection)` helper
- Add zone classification logic (leeward/windward/downwind detection)
- Add directional falloff functions for each zone type

### `src/game/TurbulenceParticle.ts` (new file)
- Extends `BaseEntity`, implements `WindModifier`
- `onAdd()`: Register with Wind
- `onTick()`:
  - Query wind velocity at current position
  - Update position based on velocity
  - Decay intensity
  - Destroy when faded or too old
- `onDestroy()`: Unregister from Wind
- `getWindVelocityContribution()`: Return chaotic velocity in small radius

### `src/game/Wind.ts`
- No changes needed - existing modifier system handles everything

### `src/game/WindModifier.ts`
- No changes needed - interface is sufficient

---

## Execution Order

### Phase 1: Per-Segment State (no behavior change yet)
1. Add `SailSegmentState` interface to `Sail.ts`
2. Add `segmentStates` array to Sail class
3. Refactor `updateWindModifierState()` to populate per-segment data
4. Keep existing `getWindVelocityContribution()` working (uses first segment or averages)

**Checkpoint**: Sail still works, segment data is being computed

### Phase 2: Directional Wind Contribution
1. Add zone classification helpers to `sail-helpers.ts`:
   - `classifyQueryZone(segmentPos, segmentNormal, windDir, queryPoint)`
   - Returns: `'leeward' | 'windward' | 'downwind' | 'upwind'`
2. Add per-zone contribution functions:
   - `getLeewardContribution(segment, queryPoint, distance)` - acceleration
   - `getWindwardContribution(segment, queryPoint, distance)` - deceleration
   - `getDownwindContribution(segment, queryPoint, distance)` - wake/shadow
3. Refactor `getWindVelocityContribution()` to iterate segments and sum directional contributions
4. Remove old symmetric circulation code

**Checkpoint**: Wind field now shows directional effects around sails

### Phase 3: Turbulence Particles
1. Create `TurbulenceParticle.ts` entity
2. Add stall transition tracking to Sail (`prevSegmentStalled: boolean[]`)
3. Add `spawnTurbulence(segmentIndex)` method to Sail
4. Call spawn on stall transitions in `onTick()`
5. Remove inline random turbulence from `getWindVelocityContribution()`

**Checkpoint**: Turbulence visibly propagates downwind from stalled sails

### Phase 4: Tuning & Polish
1. Tune influence radii and falloff curves
2. Tune turbulence spawn rate, intensity, lifetime
3. Tune zone boundaries and contribution magnitudes
4. Test slot effect (jib accelerating mainsail flow)
5. Test wind shadow (mainsail blocking jib on wrong tack)
6. Verify performance with wind visualization enabled

---

## Performance Considerations

### Per-Segment Iteration
- 32 segments per sail × 2 sails = 64 segments max
- Each wind query iterates segments, but:
  - Quick dot-product early-out for zone classification
  - Distance check before expensive math
  - Most segments won't affect most query points

### Turbulence Particle Count
- Spawn rate limiting: max N particles per sail per second
- Short lifetime: 1-2 seconds
- Expected steady-state: 10-30 particles during heavy stall
- Each particle has small influence radius, cheap contribution calc

### Optimization Opportunities (if needed later)
- Spatial hashing for segment lookup
- Skip segments that are far from query point
- LOD: reduce segment count for distant sails
- Pool turbulence particles instead of create/destroy

---

## Testing Plan

1. **Visual verification**: Use wind visualization modes to confirm:
   - Asymmetric flow around sails (faster on leeward)
   - Wind shadow extending downwind
   - Turbulence particles drifting from stalled sections

2. **Sail interaction**: Verify jib affects mainsail:
   - Trim jib tight, observe accelerated flow at mainsail luff
   - Overtrim jib, observe disturbed flow reaching mainsail

3. **Stall behavior**:
   - Luff sail to stall, observe turbulence spawning
   - Trim in, observe turbulence stopping
   - Partial stall (head stalled, clew attached) creates localized turbulence

4. **Performance**:
   - Profile with both sails up and visualization on
   - Confirm no frame drops at 120Hz physics tick

---

## Open Questions (Resolved)

1. **Should sail affect its own wind queries?**
   → Accept 1-tick delay. Sail queries wind including other sails' modifiers, but its own modifier uses previous tick's state.

2. **How to handle very close query points?**
   → Minimum distance threshold (existing `WIND_MIN_DISTANCE = 5`), clamp contribution magnitude.

3. **Turbulence coherence vs randomness?**
   → Use seeded noise based on particle ID + time for deterministic-looking chaos rather than pure random.
