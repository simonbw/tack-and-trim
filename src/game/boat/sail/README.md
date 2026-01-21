# Sail System

This directory contains the sail simulation for Tack & Trim. The system models realistic sail aerodynamics using a particle-based soft body with flow propagation physics.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                           Sail.ts                               │
│  Main entity: particle chain + constraints + lifecycle          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ delegates to
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SailFlowSimulator.ts                         │
│  Flow propagation: geometry → flow states → pressure fields     │
└───────────────────────────┬─────────────────────────────────────┘
                            │ produces
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SailSegment.ts + FlowState.ts                │
│  Data structures: geometry, flow velocity, attachment, pressure │
└───────────────────────────┬─────────────────────────────────────┘
                            │ consumed by
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    sail-aerodynamics.ts                         │
│  Force application: lift/drag from flow state → body forces     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        TellTail.ts                              │
│  Visual indicator: particle streamer showing flow direction     │
└─────────────────────────────────────────────────────────────────┘
```

## File Descriptions

### Sail.ts
The main entity class. Creates a chain of physics particles connected by distance constraints to form a soft-body sail. Handles:
- Particle chain construction (head to clew)
- Constraint setup (particle-to-particle + attachment to boat)
- Hoist/lower animation state
- Per-tick force application via `SailFlowSimulator`
- Rendering with billow visualization
- `WindModifier` interface for sail-to-sail interaction

### SailFlowSimulator.ts
Core physics simulation. Propagates flow state from luff (leading edge) to leech (trailing edge):
- Updates segment geometry from particle positions
- Computes apparent wind at each segment (base wind + upwind sail contributions)
- Determines flow attachment/separation based on angle of attack
- Calculates pressure coefficients for sail-to-sail wind shadowing

### SailSegment.ts
Data structure for a single sail segment:
- `position`, `tangent`, `normal` - Geometry in world space
- `length`, `camber` - Dimensions and curvature
- `flow` - The propagated flow state
- `pressureWindward`, `pressureLeeward` - Pressure coefficients

### FlowState.ts
Data structure for airflow at a segment:
- `velocity`, `speed` - Apparent wind vector and magnitude
- `attached` - Whether flow is attached to the sail surface
- `turbulence` - Inherited turbulence intensity (0-1)
- `pressure` - Pressure coefficient (Cp)
- `stallDistance` - Distance along sail since stall started

### sail-aerodynamics.ts
Force calculations using thin airfoil theory:
- `getSailLiftCoefficient()` - Lift coefficient vs angle of attack with stall model
- `computeDragCoefficient()` - Base + induced + stall drag
- `applySailForces()` - Applies lift/drag forces to particle bodies

### TellTail.ts
Visual feedback entity. A small particle streamer attached to the sail leech that shows the player how air is flowing off the sail. Purely visual - doesn't affect physics.

## Physics Model

### Sail Structure
The sail is modeled as a chain of `N` particles (default 32) connected by distance constraints:

```
Head ○───○───○───○───○───○───○ Clew
     │   │   │   │   │   │   │
     └───┴───┴───┴───┴───┴───┘
         Distance constraints
         (slight slack allows billow)
```

- **Head**: First particle, constrained to mast/forestay
- **Clew**: Last particle, constrained to boom end (mainsail) or free (jib)
- **Slack factor**: 1.01 allows 1% extra length for natural billow

### Flow Propagation
Flow state propagates from luff to leech, modeling how upstream conditions affect downstream:

1. **Entry conditions**: Apparent wind at leading edge
2. **Attachment check**: If angle of attack < 15°, flow stays attached
3. **Turbulence inheritance**: Upstream turbulence decays but persists
4. **Separation cascade**: Once stalled, flow stays separated downstream

```
Wind →  ╭─────────────────╮
        │ attached flow   │ → lift
        ╰─────────────────╯

Wind →  ╭───────╮╱╱╱╱╱╱╱╱╱
        │ stall │ separated → reduced lift, increased drag
        ╰───────╯
```

### Aerodynamic Forces

Forces are computed per-segment using thin airfoil theory:

**Lift coefficient** (pre-stall):
```
Cl = 2π × sin(α)
```
Where α is the angle of attack.

**Post-stall** (α > 15°):
```
Cl = Cl_peak × e^(-3(α - α_stall))
```
Lift decays exponentially after stall.

**Drag coefficient**:
```
Cd = 0.02 (base) + 0.1α² (induced) + stall_penalty
```

**Forces applied**:
- **Lift**: Perpendicular to flow direction, magnitude = Cl × q × A
- **Drag**: Opposing flow direction, magnitude = Cd × q × A
- **q** = dynamic pressure = ½ρv²
- **A** = segment area = length × chord × hoist_amount

### Sail-to-Sail Interaction

Sails affect each other through pressure fields:

1. **Upwind determination**: At each tick, sails identify which other sails are upwind using wind direction at the midpoint between sails
2. **Flow computation order**: Upwind sails compute their flow states first
3. **Contribution query**: Downwind sails query upwind sails for velocity contributions at each segment
4. **Leeward acceleration**: Air accelerates on the leeward side of upwind sails
5. **Windward blocking**: Air slows on the windward side

This models the "slot effect" between jib and mainsail, where the jib accelerates airflow over the main's leeward surface.

### Pressure Field Model

Each segment generates a local pressure field:

- **Leeward side** (normal component > 0.2): Accelerates flow along tangent
- **Windward side** (normal component < -0.2): Blocks incoming flow
- **Falloff**: Linear decay over `SEGMENT_INFLUENCE_RADIUS` (default ~10 ft)

## Code Patterns

### Lazy Flow Computation
`Sail.getFlowStates()` uses per-frame caching:
```typescript
if (this.flowComputedFrame === currentFrame) {
  return this.cachedSegments;
}
```
This ensures flow is computed exactly once per tick regardless of how many times it's queried.

### Recursion Guard
Sail-to-sail queries could cause infinite loops. The midpoint wind direction check guarantees asymmetry:
```typescript
// If A sees B as upwind, B cannot see A as upwind
const midpoint = myPos.add(otherPos).mul(0.5);
const windDir = wind.getBaseVelocityAtPoint(midpoint).normalize();
const toOther = otherPos.sub(myPos);
return toOther.dot(windDir) < 0; // Other sail is upwind
```

### Segment Pooling
`SailFlowSimulator` reuses segment objects to avoid allocation:
```typescript
while (this.segments.length < numSegments) {
  this.segments.push(this.createEmptySegment());
}
```

### Hoist Animation
Sail appearance smoothly transitions via `hoistAmount` (0-1):
- Billow scales with hoist amount (sail flattens when lowering)
- Alpha fades out near the end of lowering
- Forces scale with hoist amount

## Configuration

Key parameters in `Sail.ts`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `nodeCount` | 32 | Particles in the chain |
| `nodeMass` | 0.04 lbs | Mass per particle |
| `slackFactor` | 1.01 | Constraint slack (1% extra) |
| `billowInner` | 0.8 | Billow scale at boom |
| `billowOuter` | 2.4 | Billow scale at leech |
| `windInfluenceRadius` | 15 ft | Sail's wind shadow radius |
| `hoistSpeed` | 0.4 | Hoist/lower animation speed |

Aerodynamic constants in `sail-aerodynamics.ts`:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `STALL_ANGLE` | 15° | Angle of attack at which stall begins |
| `baseDrag` | 0.02 | Minimum drag coefficient |
| `inducedDrag` | 0.1α² | Drag from lift generation |

## Usage Example

```typescript
// Create a mainsail attached to mast and boom
const mainsail = new Sail({
  getHeadPosition: () => mast.getTopPosition(),
  getClewPosition: () => boom.getEndPosition(),
  headConstraint: { body: mastBody, localAnchor: V(0, -mastHeight/2) },
  clewConstraint: { body: boomBody, localAnchor: V(boomLength, 0) },
  sailShape: "boom",
});

// Create a jib with free clew (controlled by sheet)
const jib = new Sail({
  getHeadPosition: () => forestay.getTopPosition(),
  initialClewPosition: forestay.getBottomPosition(),
  headConstraint: { body: mastBody, localAnchor: V(0, -mastHeight/2) },
  sailShape: "triangle",
  extraPoints: () => [masthead.position], // For triangle rendering
});

// Hoist the sail
mainsail.setHoisted(true);
```
