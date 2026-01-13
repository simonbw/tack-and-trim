# Gameplan: Wind & Sail Aerodynamics Redesign

## Current State

The sail aerodynamics system has structural issues preventing realistic behavior:

**Files:**
- `src/game/boat/Sail.ts` - 32-particle chain, calls `applyFluidForces()` per segment independently
- `src/game/boat/SailWindEffect.ts` - Wind modifier using aggregate state (centroid, average lift coefficient)
- `src/game/boat/sail-helpers.ts` - Lift/drag coefficient curves (CAMBER_LIFT_FACTOR = 0)
- `src/game/TurbulenceParticle.ts` - Spawned when sails stall, drifts with wind
- `src/game/fluid-dynamics.ts` - Generic `applyFluidForces()` for edges
- `src/game/Wind.ts` - Base wind + simplex noise, queries modifiers
- `src/game/wind/WindInfo.ts` - GPU tile management

**Problems:**
1. `SailWindEffect` uses aggregate state - loses per-segment detail for slot effect
2. Each segment queries wind independently - no flow-along-sail propagation
3. Stall at luff doesn't affect downstream segments
4. Camber lift factor disabled

## Desired Changes

### Goal 1: Intra-Sail Flow State
Simulate flow along the sail chord from luff to leech:
- Each segment receives flow state from upstream segment
- Flow state: velocity, pressure, turbulence, attached (boolean)
- Stall propagates downstream via turbulence

### Goal 2: Sail-to-Sail Interaction via Segments
Replace aggregate `SailWindEffect` with per-segment contributions:
- Each segment creates pressure differential (high windward, low leeward)
- Other sails query nearby segments for pressure contribution
- Enables slot effect: jib's leeward low-pressure accelerates flow to mainsail

### Architecture Overview

```
Wind.ts (keep)
  └─ Base wind + simplex noise (GPU tiles for visualization)

Sail.ts (modified)
  └─ Owns SailFlowSimulator
  └─ Implements WindModifier directly (replaces SailWindEffect child)
  └─ Lazy flow computation via getFlowStates()
  └─ Queries upwind sails for contributions

SailFlowSimulator.ts (new)
  └─ Per-sail flow propagation from luff to leech
  └─ Returns SailSegment[] with flow states

sail-aerodynamics.ts (new)
  └─ Force computation from flow state
  └─ Replaces applyFluidForces() calls for sails
```

**Key Design: Lazy Computation with Caching**

Each Sail has a `getFlowStates()` method that:
1. If already computed this frame → return cached result
2. If not computed → call `getFlowStates()` on upwind sails first, then compute own flow, cache, and return

This naturally resolves dependencies without a coordinator entity or frame latency.

## Files to Modify

### New Files

- `src/game/boat/FlowState.ts` - FlowState interface definition
- `src/game/boat/SailSegment.ts` - SailSegment interface with geometry + flow
- `src/game/boat/SailFlowSimulator.ts` - Per-sail flow propagation
- `src/game/boat/sail-aerodynamics.ts` - Force computation from flow state

### Modified Files

- `src/game/boat/Sail.ts` - Add flow simulation, implement WindModifier, remove SailWindEffect child
- `src/game/wind/WindConstants.ts` - Add flow propagation constants

### Deleted Files

- `src/game/boat/SailWindEffect.ts` - Functionality moved into Sail.ts
- `src/game/TurbulenceParticle.ts` - Turbulence embedded in flow state

## Execution Order

### Phase 1: Flow State Infrastructure (no dependencies)

1. Create `src/game/boat/FlowState.ts`:
```typescript
import { V2d } from "../../core/Vector";

export interface FlowState {
  velocity: V2d;        // Apparent wind velocity at this segment
  speed: number;        // Magnitude (cached for convenience)
  attached: boolean;    // Is flow attached to surface?
  turbulence: number;   // 0-1 turbulence intensity
  pressure: number;     // Pressure coefficient (Cp)
  stallDistance: number; // Distance since stall started (0 = attached)
}

export const DEFAULT_FLOW_STATE: FlowState = {
  velocity: V(0, 0),
  speed: 0,
  attached: true,
  turbulence: 0,
  pressure: 0,
  stallDistance: 0,
};
```

2. Create `src/game/boat/SailSegment.ts`:
```typescript
import { V2d } from "../../core/Vector";
import { FlowState } from "./FlowState";

export interface SailSegment {
  // Geometry (computed from particle positions)
  position: V2d;        // Segment midpoint in world coords
  tangent: V2d;         // Unit vector along segment (luff to leech direction)
  normal: V2d;          // Unit vector perpendicular (leeward side)
  length: number;       // Segment length in ft
  camber: number;       // Local curvature (0 = flat)

  // Flow state (propagated from luff)
  flow: FlowState;

  // Pressure field (for sail-to-sail interaction)
  pressureWindward: number;   // High pressure side (positive)
  pressureLeeward: number;    // Low pressure side (negative = suction)
}
```

3. Add constants to `src/game/wind/WindConstants.ts`:
```typescript
// Flow propagation constants
export const TURBULENCE_DECAY = 0.9;           // Per-segment turbulence decay
export const TURBULENCE_STALL_INJECTION = 0.3; // Turbulence added when segment stalls
export const TURBULENCE_DETACH_THRESHOLD = 0.5; // Turbulence level that causes detachment
export const SEPARATION_DECAY_RATE = 0.1;      // How quickly separated flow recovers
export const SEGMENT_INFLUENCE_RADIUS = 8;     // ft - how far segment pressure extends
```

### Phase 2: SailFlowSimulator (depends on Phase 1)

Create `src/game/boat/SailFlowSimulator.ts`:

```typescript
export class SailFlowSimulator {
  private segments: SailSegment[] = [];

  /**
   * Compute flow states for all segments.
   * @param bodies - Sail particle bodies
   * @param head - Head position
   * @param clew - Clew position
   * @param baseWind - Wind velocity at sail (before other sail contributions)
   * @param getUpwindContribution - Query function for upwind sail effects
   * @returns Array of segments with computed flow states
   */
  simulate(
    bodies: Body[],
    head: V2d,
    clew: V2d,
    baseWind: V2d,
    getUpwindContribution: (point: V2d) => V2d,
  ): SailSegment[] {
    // 1. Update segment geometry from particle positions
    this.updateGeometry(bodies, head, clew);

    // 2. Propagate flow from luff to leech
    let upstreamFlow = DEFAULT_FLOW_STATE;

    for (const segment of this.segments) {
      // Get apparent wind at this segment (base + upwind sail contributions)
      const contribution = getUpwindContribution(segment.position);
      const apparentWind = baseWind.add(contribution);

      // Compute flow state based on upstream + local geometry
      segment.flow = this.computeFlowState(segment, apparentWind, upstreamFlow);

      // Compute pressure field for this segment
      this.computePressure(segment);

      upstreamFlow = segment.flow;
    }

    return this.segments;
  }

  private updateGeometry(bodies: Body[], head: V2d, clew: V2d): void {
    // Resize segments array if needed
    // For each segment: compute position, tangent, normal, length, camber
    // (Similar to current SailWindEffect.updateState logic)
  }

  private computeFlowState(
    segment: SailSegment,
    apparentWind: V2d,
    upstream: FlowState,
  ): FlowState {
    // 1. Compute angle of attack
    // 2. Check for stall condition
    // 3. Propagate turbulence from upstream
    // 4. Determine if flow is attached
    // 5. Return new FlowState
  }

  private computePressure(segment: SailSegment): void {
    // Compute pressureWindward and pressureLeeward from flow state
  }
}
```

### Phase 3: sail-aerodynamics.ts (depends on Phase 1)

Create `src/game/boat/sail-aerodynamics.ts`:

```typescript
import { SailSegment } from "./SailSegment";
import { RHO_AIR } from "../fluid-dynamics";

/**
 * Apply aerodynamic forces to a sail particle based on its segment's flow state.
 */
export function applySailForces(
  body: DynamicBody,
  segment: SailSegment,
  chord: number,
  forceScale: number,
): void {
  const { flow, length, tangent, camber } = segment;

  if (flow.speed < 0.01) return;

  // Dynamic pressure: q = 0.5 * ρ * v²
  const q = 0.5 * RHO_AIR * flow.speed * flow.speed;
  const area = length * chord * forceScale;

  // Compute angle of attack
  const flowDir = flow.velocity.normalize();
  const aoa = Math.acos(clamp(flowDir.dot(tangent), -1, 1));

  let lift: number;
  let drag: number;

  if (flow.attached) {
    // Attached flow - standard thin airfoil
    const cl = computeLiftCoefficient(aoa, camber);
    const cd = computeDragCoefficient(aoa, camber);
    lift = cl * q * area;
    drag = cd * q * area;
  } else {
    // Separated flow - reduced lift, increased drag
    const separationFactor = Math.exp(-flow.stallDistance * SEPARATION_DECAY_RATE);
    const cl = computeLiftCoefficient(aoa, camber) * separationFactor * 0.3;
    const cd = computeDragCoefficient(aoa, camber) + 0.5 * (1 - separationFactor);
    lift = cl * q * area;
    drag = cd * q * area;

    // Turbulent buffeting
    if (flow.turbulence > 0.1) {
      const buffet = flow.turbulence * 0.2 * q * area;
      const buffetDir = V(Math.random() - 0.5, Math.random() - 0.5).inormalize();
      body.applyForce(buffetDir.mul(buffet));
    }
  }

  // Apply lift (perpendicular to flow) and drag (opposing flow)
  const liftDir = flowDir.rotate90cw();
  const liftForce = liftDir.mul(lift * Math.sign(Math.sin(aoa)));
  const dragForce = flowDir.mul(-drag);

  body.applyForce(liftForce.add(dragForce));
}

// Reuse or adapt from sail-helpers.ts
function computeLiftCoefficient(aoa: number, camber: number): number { ... }
function computeDragCoefficient(aoa: number, camber: number): number { ... }
```

### Phase 4: Modify Sail.ts (depends on Phases 2 & 3)

Update `src/game/boat/Sail.ts`:

**Add to class:**
```typescript
class Sail extends BaseEntity implements WindQuerier, WindModifier {
  tags = ["windQuerier", "sail", "windModifier"];

  // Flow simulation
  private flowSimulator = new SailFlowSimulator();
  private cachedSegments: SailSegment[] = [];
  private flowComputedFrame: number = -1;

  /**
   * Get flow states for all segments. Lazy computation with per-frame caching.
   * Automatically triggers computation of upwind sails first.
   */
  getFlowStates(): SailSegment[] {
    const currentFrame = this.game!.tickNumber;

    if (this.flowComputedFrame === currentFrame) {
      return this.cachedSegments;
    }

    // Get upwind sails and trigger their flow computation first
    const upwindSails = this.getUpwindSails();

    // Build contribution function from upwind sails
    const getUpwindContribution = (point: V2d): V2d => {
      let contribution = V(0, 0);
      for (const sail of upwindSails) {
        contribution.iadd(sail.getWindContributionAt(point));
      }
      return contribution;
    };

    // Get base wind
    const wind = this.game!.entities.getById("wind") as Wind;
    const baseWind = wind.getBaseVelocityAtPoint(this.getCentroid());

    // Run flow simulation
    this.cachedSegments = this.flowSimulator.simulate(
      this.bodies,
      this.getHeadPosition(),
      this.getClewPosition(),
      baseWind,
      getUpwindContribution,
    );
    this.flowComputedFrame = currentFrame;

    return this.cachedSegments;
  }

  /**
   * Get sails that are upwind of this sail and might affect it.
   */
  private getUpwindSails(): Sail[] {
    const wind = this.game!.entities.getById("wind") as Wind;
    const windDir = wind.getBaseVelocityAtPoint(this.getCentroid()).normalize();
    const myPos = this.getCentroid();

    const allSails = this.game!.entities.getTagged("sail") as Sail[];
    return allSails.filter(sail => {
      if (sail === this) return false;
      const toOther = sail.getCentroid().sub(myPos);
      return toOther.dot(windDir) < 0; // Other sail is upwind
    });
  }

  /**
   * Get wind velocity contribution at a point from this sail's pressure field.
   * Used by downwind sails querying this sail's effect.
   */
  getWindContributionAt(point: V2d): V2d {
    const segments = this.getFlowStates();
    let contribution = V(0, 0);

    for (const segment of segments) {
      contribution.iadd(this.getSegmentContribution(point, segment));
    }

    return contribution;
  }

  private getSegmentContribution(point: V2d, segment: SailSegment): V2d {
    const toPoint = point.sub(segment.position);
    const dist = toPoint.magnitude;

    if (dist < 1 || dist > SEGMENT_INFLUENCE_RADIUS) {
      return V(0, 0);
    }

    const toPointDir = toPoint.normalize();
    const normalComponent = toPointDir.dot(segment.normal);
    const falloff = 1 - dist / SEGMENT_INFLUENCE_RADIUS;

    // Leeward side: accelerate flow along tangent
    if (normalComponent > 0.2) {
      const accel = -segment.pressureLeeward * falloff * segment.flow.speed * 0.15;
      return segment.tangent.mul(accel);
    }
    // Windward side: block flow
    else if (normalComponent < -0.2) {
      const block = segment.pressureWindward * falloff * segment.flow.speed * 0.1;
      return segment.flow.velocity.normalize().mul(-block);
    }

    return V(0, 0);
  }

  private getCentroid(): V2d {
    const head = this.getHeadPosition();
    const clew = this.getClewPosition();
    return head.add(clew.sub(head).mul(0.33));
  }
}
```

**Modify onTick:**
```typescript
onTick(dt: number) {
  // Animate hoist (keep existing code)
  this.hoistAmount = stepToward(...);

  if (!this.isHoisted()) return;

  // Get flow states (triggers upwind sail computation if needed)
  const segments = this.getFlowStates();

  // Apply forces based on flow states
  for (let i = 0; i < this.bodies.length; i++) {
    const t = i / (this.bodies.length - 1);
    const forceScale = this.config.getForceScale(t) * this.hoistAmount;

    // Find corresponding segment (bodies.length = segments.length + 1)
    const segmentIndex = Math.min(i, segments.length - 1);
    const segment = segments[segmentIndex];

    applySailForces(
      this.bodies[i],
      segment,
      DEFAULT_SAIL_CHORD,
      forceScale,
    );
  }
}
```

**Remove:**
- `this.windEffect = this.addChild(new SailWindEffect(this))` from constructor
- The `windEffect` property

**Add WindModifier implementation:**
```typescript
// WindModifier interface
getWindModifierAABB(): AABB {
  // Return bounding box around sail + influence radius
}

getWindVelocityContribution(point: V2d): V2d {
  return this.getWindContributionAt(point);
}
```

### Phase 5: Cleanup (depends on Phase 4)

1. Delete `src/game/boat/SailWindEffect.ts`
2. Delete `src/game/TurbulenceParticle.ts`
3. Remove turbulence particle spawning references from any remaining code
4. Remove `GPUTurbulenceData` from `WindModifierData.ts` (if not needed for other purposes)

### Phase 6: GPU Pipeline Updates (optional, can defer)

If GPU wind visualization is needed:
1. Update `WindModifierData.ts` with `GPUSailSegmentData` structure
2. Update `WindModifierComputeGPU.ts` shader for segment-based computation
3. Have Sail provide `getGPUSegmentData()` method

This phase can be deferred since the base wind GPU tiles still work for visualization.

## Key Implementation Details

### Flow State Propagation Algorithm

```typescript
computeFlowState(segment, apparentWind, upstream): FlowState {
  const speed = apparentWind.magnitude;
  const flowDir = speed > 0.01 ? apparentWind.normalize() : V(1, 0);

  // Angle of attack
  const aoa = Math.acos(clamp(flowDir.dot(segment.tangent), -1, 1));
  const wouldStall = aoa > STALL_ANGLE;

  // Inherit turbulence from upstream (with decay)
  const inheritedTurbulence = upstream.turbulence * TURBULENCE_DECAY;

  // Determine attachment
  let attached: boolean;
  let turbulence: number;
  let stallDistance: number;

  if (upstream.attached && !wouldStall && inheritedTurbulence < TURBULENCE_DETACH_THRESHOLD) {
    // Flow stays attached
    attached = true;
    turbulence = inheritedTurbulence;
    stallDistance = 0;
  } else {
    // Flow separated
    attached = false;
    turbulence = Math.min(1, inheritedTurbulence + (wouldStall ? TURBULENCE_STALL_INJECTION : 0.1));
    stallDistance = upstream.stallDistance + segment.length;
  }

  // Pressure coefficient
  const pressure = attached
    ? -2 * Math.PI * Math.sin(aoa)  // Attached: suction on leeward
    : -0.5;                          // Separated: reduced suction

  return { velocity: apparentWind, speed, attached, turbulence, pressure, stallDistance };
}
```

### Pressure Field Computation

```typescript
computePressure(segment: SailSegment): void {
  const { flow, camber } = segment;

  if (!flow.attached) {
    segment.pressureWindward = 0.3;
    segment.pressureLeeward = -0.1;
    return;
  }

  const flowDir = flow.speed > 0.01 ? flow.velocity.normalize() : V(1, 0);
  const aoa = Math.acos(clamp(flowDir.dot(segment.tangent), -1, 1));
  const cl = 2 * Math.PI * Math.sin(aoa);

  segment.pressureWindward = 0.5 + 0.3 * Math.sin(aoa);
  segment.pressureLeeward = -0.5 * cl - camber * 2.0;
}
```

### Sail Tag

Sail.ts needs the `"sail"` tag for `getUpwindSails()` to work:
```typescript
tags = ["windQuerier", "sail", "windModifier"];
```

## Verification

### Test 1: Single Sail Stall Propagation
- Set high angle of attack at luff
- Verify segments downstream show increasing turbulence
- Verify lift decreases toward clew

### Test 2: Slot Effect
- Position jib and mainsail close-hauled
- Verify mainsail leading edge sees increased wind speed from jib's leeward acceleration
- Compare total lift with/without jib

### Test 3: Upwind Sail Detection
- Verify `getUpwindSails()` correctly identifies which sails are upwind
- Test with wind from different directions

### Test 4: Frame Caching
- Verify flow states are only computed once per frame per sail
- Verify no circular dependency issues

### Test 5: Sail Trim Feedback
- Verify tell-tails respond appropriately to flow state
- Verify sail forces feel reasonable when trimming
