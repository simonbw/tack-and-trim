# Phase 0: Stub API Implementation & Code Migration

**Status**: Not Started
**Start Date**: TBD
**Completion Date**: TBD
**Estimated Duration**: 1-2 days
**Depends On**: None (foundation for all other phases)

---

## Goal

Get the project to compile by creating stub implementations of all public API classes that return safe default values. Update all existing code that uses the old `WindInfo`/`WaterInfo` APIs to use the new Query-based system.

This allows development to continue on other parts of the game while the full implementation is built out in phases 1-6.

---

## Components Checklist

### Stub Implementations
- [ ] `WaterQuery.ts` - Stub query entity
- [ ] `TerrainQuery.ts` - Stub query entity
- [ ] `WindQuery.ts` - Stub query entity
- [ ] `WorldManager.ts` - Stub orchestrator
- [ ] `SurfaceRenderer.ts` - Stub renderer
- [ ] `WaterModifier.ts` - Type definitions only

### Code Migration
- [ ] Update GameController initialization
- [ ] Migrate Sail wind usage
- [ ] Migrate TellTail wind usage
- [ ] Migrate Keel water usage
- [ ] Migrate Hull water usage
- [ ] Migrate Rudder water usage
- [ ] Migrate BoatSpray water usage
- [ ] Migrate FoamParticle water usage
- [ ] Migrate BoatGrounding terrain usage
- [ ] Migrate TutorialManager wind usage
- [ ] Update SimulationStatsPanel
- [ ] Update debug modes (keep stubbed for now)

---

## Implementation Tasks

### 1. WaterQuery Stub

**File**: `src/game/world/query/WaterQuery.ts`

Create a stub that:
- Extends BaseEntity
- Accepts `getPoints: () => V2d[]` in constructor
- Returns empty arrays for `points` and `results`
- Returns `undefined` for `getResultForPoint()`
- Returns empty iterator
- Returns rejected promise for `getResultAndDestroy()`

```typescript
import { BaseEntity } from "../../../core/entity/BaseEntity";
import type { V2d } from "../../../core/util/Vector";

export interface WaterQueryResult {
  z: number;   // Surface elevation (ft)
  vx: number;  // Velocity X (ft/s)
  vy: number;  // Velocity Y (ft/s)
  vz: number;  // Velocity Z (ft/s)
}

/**
 * STUB: Water query entity. Currently returns no results.
 * Will be implemented in Phase 4.
 */
export class WaterQuery extends BaseEntity {
  private getPointsFn: () => V2d[];

  constructor(getPoints: () => V2d[]) {
    super();
    this.getPointsFn = getPoints;
  }

  get points(): readonly V2d[] {
    return [];
  }

  get results(): readonly WaterQueryResult[] {
    return [];
  }

  getResultForPoint(point: V2d): WaterQueryResult | undefined {
    return undefined;
  }

  *[Symbol.iterator](): Iterator<[V2d, WaterQueryResult]> {
    // Empty iterator
  }

  async getResultAndDestroy(): Promise<WaterQuery> {
    this.destroy();
    return this;
  }
}
```

**Lines**: ~50

---

### 2. TerrainQuery Stub

**File**: `src/game/world/query/TerrainQuery.ts`

Same pattern as WaterQuery:

```typescript
import { BaseEntity } from "../../../core/entity/BaseEntity";
import type { V2d } from "../../../core/util/Vector";

export interface TerrainQueryResult {
  height: number; // Terrain height (ft), negative = underwater
}

/**
 * STUB: Terrain query entity. Currently returns no results.
 * Will be implemented in Phase 2.
 */
export class TerrainQuery extends BaseEntity {
  private getPointsFn: () => V2d[];

  constructor(getPoints: () => V2d[]) {
    super();
    this.getPointsFn = getPoints;
  }

  get points(): readonly V2d[] {
    return [];
  }

  get results(): readonly TerrainQueryResult[] {
    return [];
  }

  getResultForPoint(point: V2d): TerrainQueryResult | undefined {
    return undefined;
  }

  *[Symbol.iterator](): Iterator<[V2d, TerrainQueryResult]> {
    // Empty iterator
  }

  async getResultAndDestroy(): Promise<TerrainQuery> {
    this.destroy();
    return this;
  }
}
```

**Lines**: ~45

---

### 3. WindQuery Stub

**File**: `src/game/world/query/WindQuery.ts`

Same pattern:

```typescript
import { BaseEntity } from "../../../core/entity/BaseEntity";
import type { V2d } from "../../../core/util/Vector";

export interface WindQueryResult {
  vx: number; // Wind velocity X (ft/s)
  vy: number; // Wind velocity Y (ft/s)
}

/**
 * STUB: Wind query entity. Currently returns no results.
 * Will be implemented in Phase 3.
 */
export class WindQuery extends BaseEntity {
  private getPointsFn: () => V2d[];

  constructor(getPoints: () => V2d[]) {
    super();
    this.getPointsFn = getPoints;
  }

  get points(): readonly V2d[] {
    return [];
  }

  get results(): readonly WindQueryResult[] {
    return [];
  }

  getResultForPoint(point: V2d): WindQueryResult | undefined {
    return undefined;
  }

  *[Symbol.iterator](): Iterator<[V2d, WindQueryResult]> {
    // Empty iterator
  }

  async getResultAndDestroy(): Promise<WindQuery> {
    this.destroy();
    return this;
  }
}
```

**Lines**: ~45

---

### 4. WaterModifier Interface

**File**: `src/game/world/water/WaterModifier.ts`

Just type definitions, no implementation needed:

```typescript
import type { V2d } from "../../../core/util/Vector";

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type WaterModifierData =
  | { type: "segment"; p1: V2d; p2: V2d; amplitude: number; falloff: number }
  | { type: "point"; center: V2d; radius: number; amplitude: number }
  | { type: "ring"; center: V2d; radius: number; width: number; amplitude: number };

/**
 * Interface for entities that disturb water surface (wakes, splashes, ripples).
 * Entities should tag themselves with "waterModifier" for collection.
 *
 * Will be used in Phase 4.
 */
export interface WaterModifier {
  getBounds(): AABB;
  getModifierData(): WaterModifierData;
}
```

**Lines**: ~25

---

### 5. WorldManager Stub

**File**: `src/game/world/WorldManager.ts`

Minimal stub that accepts a level definition:

```typescript
import { BaseEntity } from "../../core/entity/BaseEntity";
import type { V2d } from "../../core/util/Vector";

export interface TerrainContour {
  controlPoints: readonly V2d[];
  height: number;
}

export interface TerrainDefinition {
  contours: TerrainContour[];
  defaultDepth: number;
}

export interface WaveSourceConfig {
  direction: number;
  baseAmplitude: number;
  wavelength: number;
}

export interface LevelDefinition {
  terrain: TerrainDefinition;
  waveSources: WaveSourceConfig[];
  baseWind: { direction: number; speed: number };
  tide?: { range: number; frequency: number };
}

/**
 * STUB: World manager that orchestrates terrain, water, and wind systems.
 * Currently does nothing. Will be implemented in Phase 6.
 */
export class WorldManager extends BaseEntity {
  readonly id = "worldManager";
  readonly tickLayer = "environment";

  private level: LevelDefinition;

  constructor(level: LevelDefinition) {
    super();
    this.level = level;
  }

  getBaseWind(): V2d {
    const { direction, speed } = this.level.baseWind;
    return new V2d(
      speed * Math.cos(direction),
      speed * Math.sin(direction)
    );
  }
}
```

**Lines**: ~55

---

### 6. SurfaceRenderer Stub

**File**: `src/game/world/rendering/SurfaceRenderer.ts`

Minimal stub entity:

```typescript
import { BaseEntity } from "../../../core/entity/BaseEntity";

/**
 * STUB: Surface renderer for terrain, water, and wetness.
 * Currently does nothing. Will be implemented in Phase 5.
 */
export class SurfaceRenderer extends BaseEntity {
  readonly id = "surfaceRenderer";
  readonly renderLayer = "water";

  constructor() {
    super();
  }
}
```

**Lines**: ~15

---

## Code Migration Tasks

### 7. GameController Updates

**File**: `src/game/GameController.ts`

**Changes**:
- [ ] Remove TODOs at lines 20, 25, 27, 40, 52
- [ ] Add WorldManager initialization
- [ ] Add SurfaceRenderer initialization
- [ ] Keep buoys/wind particles commented for now

```typescript
import { WorldManager, type LevelDefinition } from "./world/WorldManager";
import { SurfaceRenderer } from "./world/rendering/SurfaceRenderer";

// In onAdd():
// Initialize world systems with minimal level definition
const levelData: LevelDefinition = {
  terrain: {
    contours: [],
    defaultDepth: -50,
  },
  waveSources: [],
  baseWind: { direction: Math.PI / 4, speed: 15 },
};

this.addChild(new WorldManager(levelData));
this.addChild(new SurfaceRenderer());

// TODO: Spawn buoys once Phase 4 (water) is implemented
// TODO: Spawn wind particles once Phase 3 (wind) is implemented
```

---

### 8. Boat Components Migration

#### Sail Updates

**File**: `src/game/boat/sail/Sail.ts`

**Changes**:
- [ ] Replace `WindInfo` usage with `WindQuery`
- [ ] Create WindQuery as child entity
- [ ] Update `applyForcesFromWind()` to use query results
- [ ] Keep base wind fallback via WorldManager

```typescript
import { WindQuery, type WindQueryResult } from "../../world/query/WindQuery";
import { WorldManager } from "../../world/WorldManager";

class Sail extends BaseEntity {
  private windQuery!: WindQuery;

  @on("add")
  onAdd() {
    // Create wind query for sail evaluation points
    this.windQuery = this.addChild(
      new WindQuery(() => this.getWindQueryPoints())
    );
  }

  private getWindQueryPoints(): V2d[] {
    // Return points along the sail for wind evaluation
    return this.nodes.map(node => node.body.getPosition());
  }

  @on("tick")
  onTick() {
    // Use query results if available, otherwise fallback to base wind
    if (this.windQuery.results.length > 0) {
      this.applyForcesFromWindQuery();
    } else {
      this.applyForcesFromBaseWind();
    }
  }

  private applyForcesFromWindQuery() {
    for (const [point, wind] of this.windQuery) {
      const windVec = new V2d(wind.vx, wind.vy);
      // Apply forces using wind data
    }
  }

  private applyForcesFromBaseWind() {
    // Fallback when query results not ready
    const manager = this.game.entities.getById("worldManager") as WorldManager;
    if (!manager) return;

    const baseWind = manager.getBaseWind();
    // Apply forces using constant base wind
  }
}
```

---

#### TellTail Updates

**File**: `src/game/boat/sail/TellTail.ts`

Similar pattern to Sail - create WindQuery, use results or fallback to base wind.

---

#### Keel Updates

**File**: `src/game/boat/Keel.ts`

**Changes**:
- [ ] Replace `WaterInfo` with `WaterQuery`
- [ ] Create query for keel position
- [ ] Use results for hydrodynamic forces

```typescript
import { WaterQuery, type WaterQueryResult } from "../world/query/WaterQuery";

class Keel extends BaseEntity {
  private waterQuery!: WaterQuery;

  @on("add")
  onAdd() {
    this.waterQuery = this.addChild(
      new WaterQuery(() => [this.body.getPosition()])
    );
  }

  @on("tick")
  onTick() {
    const result = this.waterQuery.getResultForPoint(this.body.getPosition());
    if (!result) return; // No data yet

    const waterVelocity = new V2d(result.vx, result.vy);
    // Apply hydrodynamic forces
  }
}
```

---

#### Hull Updates

**File**: `src/game/boat/Hull.ts`

Same pattern as Keel - query water at hull vertices for skin friction.

---

#### Rudder Updates

**File**: `src/game/boat/Rudder.ts`

Same pattern as Keel - query water at rudder position for forces.

---

### 9. Effects Migration

#### BoatSpray Updates

**File**: `src/game/BoatSpray.ts`

**Changes**:
- [ ] Create WaterQuery for spray evaluation points
- [ ] Use query results to determine spray intensity
- [ ] Disable spray if no water data available

---

#### FoamParticle Updates

**File**: `src/game/FoamParticle.ts`

**Changes**:
- [ ] Create WaterQuery for particle position
- [ ] Use query results to update particle motion
- [ ] Fade out if no water data

---

### 10. Tutorial System Updates

#### TutorialManager Updates

**File**: `src/game/tutorial/TutorialManager.ts`

**Changes**:
- [ ] Replace `WindInfo.fromGame()` with `WorldManager.getBaseWind()`
- [ ] Update TutorialContext to not require WindInfo

```typescript
import { WorldManager } from "../world/WorldManager";

// In onStart():
const manager = this.game.entities.getById("worldManager") as WorldManager;
const baseWind = manager?.getBaseWind() ?? new V2d(0, 0);

this.context = {
  boat: this.boat,
  baseWind: baseWind, // Just the vector, not the full info object
};
```

---

#### TutorialStep Interface Updates

**File**: `src/game/tutorial/TutorialStep.ts`

**Changes**:
- [ ] Remove `WindInfo` from TutorialContext
- [ ] Add `baseWind: V2d` instead

```typescript
export interface TutorialContext {
  boat: Boat;
  baseWind: V2d; // Changed from windInfo: WindInfo
}
```

---

### 11. BoatGrounding Updates

**File**: `src/game/boat/BoatGrounding.ts`

**Changes**:
- [ ] Create TerrainQuery for hull vertices
- [ ] Use query results for grounding detection
- [ ] Assume deep water if no terrain data

```typescript
import { TerrainQuery, type TerrainQueryResult } from "../world/query/TerrainQuery";

class BoatGrounding extends BaseEntity {
  private terrainQuery!: TerrainQuery;

  @on("add")
  onAdd() {
    this.terrainQuery = this.addChild(
      new TerrainQuery(() => this.getQueryPoints())
    );
  }

  @on("tick")
  onTick() {
    if (this.terrainQuery.results.length === 0) {
      // No terrain data yet, assume deep water
      return;
    }

    for (const [point, terrain] of this.terrainQuery) {
      if (terrain.height > -5) { // Shallow water
        // Apply grounding forces
      }
    }
  }
}
```

---

### 12. SimulationStatsPanel Updates

**File**: `src/game/stats/SimulationStatsPanel.tsx`

**Changes**:
- [ ] Remove WindInfo/WaterInfo imports
- [ ] Remove stats collection (will be reimplemented in later phases)
- [ ] Show "Not implemented" message

```typescript
// Remove these:
// import { WaterInfo } from "../water/WaterInfo";
// import { WindInfo } from "../wind/WindInfo";

// In component:
return (
  <Panel title="Simulation Stats">
    <p>Query system stats will be available after Phase 1-4 implementation.</p>
  </Panel>
);
```

---

### 13. Debug Modes Updates

Keep all four debug modes stubbed out for now. They'll be reimplemented in their respective phases:

- `WindFieldDebugMode.ts` - Phase 3
- `WaveEnergyDebugMode.ts` - Phase 4
- `TerrainHeightsDebugMode.ts` - Phase 2
- `DepthGridDebugMode.ts` - Phase 2

No changes needed - they're already stubbed.

---

## Testing Checklist

### Compilation
- [ ] Project compiles with no TypeScript errors
- [ ] No missing imports
- [ ] All stubs properly typed

### Runtime
- [ ] Game starts without crashing
- [ ] Boat spawns and physics works (even without water data)
- [ ] No console errors from missing query results
- [ ] Tutorial starts (with base wind only)
- [ ] Debug modes don't crash (just show "not implemented")

### Graceful Degradation
- [ ] Boat still moves when pushed (no water resistance without queries)
- [ ] Sails still work with base wind fallback
- [ ] Effects (spray, foam) gracefully disable without water data
- [ ] No division by zero or null reference errors

---

## Files Created/Modified

```
CREATE:
src/game/world/
  ├── WorldManager.ts              [ ] ~55 lines
  └── query/
      ├── WaterQuery.ts            [ ] ~50 lines
      ├── TerrainQuery.ts          [ ] ~45 lines
      └── WindQuery.ts             [ ] ~45 lines
  └── water/
      └── WaterModifier.ts         [ ] ~25 lines
  └── rendering/
      └── SurfaceRenderer.ts       [ ] ~15 lines

MODIFY:
src/game/
  ├── GameController.ts            [ ] -5 TODOs, +15 lines
  ├── BoatSpray.ts                 [ ] ~20 line changes
  ├── FoamParticle.ts              [ ] ~15 line changes
  └── boat/
      ├── Keel.ts                  [ ] ~20 line changes
      ├── Hull.ts                  [ ] ~20 line changes
      ├── Rudder.ts                [ ] ~20 line changes
      ├── BoatGrounding.ts         [ ] ~30 line changes
      └── sail/
          ├── Sail.ts              [ ] ~40 line changes
          └── TellTail.ts          [ ] ~20 line changes
  └── tutorial/
      ├── TutorialManager.ts       [ ] ~15 line changes
      └── TutorialStep.ts          [ ] ~5 line changes
  └── stats/
      └── SimulationStatsPanel.tsx [ ] ~20 line changes
```

**Total New Code**: ~235 lines (stubs)
**Total Modified Code**: ~240 lines (migrations)

---

## Completion Criteria

Phase 0 is complete when:
- [ ] All 6 stub files created
- [ ] Project compiles with no errors
- [ ] Game runs without crashing
- [ ] All 12 usage sites updated
- [ ] No console errors on startup
- [ ] Boat physics works (degraded without queries)
- [ ] Tutorial starts successfully
- [ ] Ready to begin Phase 1 implementation

---

## Notes & Decisions

### Why Stubs Return Empty/Undefined?

- **Safe defaults**: Empty arrays and undefined are safe - code can check `if (results.length === 0)` or `if (!result)`
- **No fake data**: Better to have no data than wrong data that could hide bugs
- **Graceful degradation**: Entities can fall back to simpler behavior (e.g., base wind instead of spatial wind)

### Migration Strategy

1. **Query creation**: Add queries as child entities in `onAdd()`
2. **Result checking**: Always check `results.length === 0` or `!result` before using
3. **Fallback behavior**: Provide sensible defaults when no data available
4. **No blocking**: Never `await` queries in physics tick - use previous frame's data

### Future Compatibility

All stubs follow the exact API from `world-system-api.md`, so when real implementations land in phases 1-6, the migration is just swapping stub files for real ones. No API changes needed.

---

## Risk Mitigation

### Performance Impact
- Stub queries have minimal overhead (empty arrays, no-op methods)
- No GPU work or async operations
- Should not impact frame rate

### Gameplay Impact
- Boat will feel "floaty" without water resistance (expected)
- Sails work but with constant wind (acceptable for testing)
- Effects won't appear (spray, foam) but won't crash

### Testing Impact
- Can test boat controls and basic physics
- Can test UI and tutorial flow
- Can test level loading with WorldManager

This phase enables parallel development - game features can progress while world system is built.
