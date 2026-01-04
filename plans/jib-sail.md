# Gameplan: Refactor Sail Classes

## Current State

After adding the jib, there's significant duplication between `Sail.ts` and `Jib.ts`:

- `src/game/boat/Sail.ts` - Mainsail with 32-node particle chain, WindModifier, double-pass billow rendering
- `src/game/boat/Jib.ts` - Jib with 32-node particle chain, WindModifier, triangle rendering
- Both share ~80% identical code (particle creation, constraints, wind forces, WindModifier)

Key differences:
| Aspect | Mainsail | Jib |
|--------|----------|-----|
| Head attachment | Boom body at pivot | Hull at mast |
| Clew attachment | Boom body at end | Free (sheets) |
| Force distribution | `1.0 - t` (triangular) | Uniform |
| Rendering | Double-pass billow | Triangle polygon |

## Desired Changes

Consolidate into a single parameterized `Sail` class:
- **TellTail**: Config option, add to both sails
- **Rendering**: Unified double-pass billow style (from mainsail), configurable BILLOW_INNER/OUTER
- **Constraints**: Optional clew constraint (mainsail has it, jib doesn't)
- **Force scaling**: Configurable function

## Files to Modify

### Rewrite

- `src/game/boat/Sail.ts` - Parameterized class with SailConfig interface:
  ```typescript
  interface SailConfig {
    // Particles
    nodeCount?: number;
    nodeMass?: number;
    slackFactor?: number;
    liftScale?: number;
    dragScale?: number;

    // Positions
    getHeadPosition: () => V2d;
    getClewPosition: () => V2d;
    getInitialClewPosition?: () => V2d;

    // Constraints
    headConstraint: { body: Body; localAnchor: V2d };
    clewConstraint?: { body: Body; localAnchor: V2d };

    // Physics
    getForceScale?: (t: number) => number;

    // Rendering
    billowInner?: number;
    billowOuter?: number;
    extraPoints?: () => V2d[];
    extraStrokes?: () => Array<{ from: V2d; to: V2d; color?: number }>;

    // Extras
    attachTellTail?: boolean;
    windInfluenceRadius?: number;
  }
  ```

### Modify

- `src/game/boat/Rig.ts` - Update mainsail creation:
  ```typescript
  this.sail = new Sail({
    getHeadPosition: () => this.getMastWorldPosition(),
    getClewPosition: () => this.getBoomEndWorldPosition(),
    headConstraint: { body: this.body, localAnchor: V(0, 0) },
    clewConstraint: { body: this.body, localAnchor: V(-boomLength, 0) },
    getForceScale: (t) => 1.0 - t,
  });
  ```

- `src/game/boat/Boat.ts` - Update jib creation:
  ```typescript
  this.jib = new Sail({
    getHeadPosition: () => this.hull.toWorld(HEAD_LOCAL),
    getClewPosition: () => V(this.jib.getClew().position),
    getInitialClewPosition: () => computeInitialClew(),
    headConstraint: { body: this.hull.body, localAnchor: HEAD_LOCAL },
    billowOuter: 1.5,
    extraPoints: () => [this.hull.toWorld(TACK_LOCAL)],
    extraStrokes: () => [{ from: headPos, to: tackPos, color: 0x666666 }],
  });
  ```

### Delete

- `src/game/boat/Jib.ts` - No longer needed

## Execution Order

### Sequential (has dependencies)

1. **Rewrite Sail.ts** - Add SailConfig, unified rendering, TellTail option
2. **Update Rig.ts** - Pass mainsail config
3. **Update Boat.ts** - Create jib using Sail with jib config
4. **Delete Jib.ts**
5. **Run type check**
