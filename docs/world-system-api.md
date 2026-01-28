# World System Public API

This document describes the public-facing API for the world rendering and simulation systems. It covers how game entities query world data (terrain, water, wind) and how to add surface rendering to a game.

---

## Overview

There are two things game code interacts with:

1. **Query entities** — Register points and read back results. Used by entities for physics, AI, etc.
2. **SurfaceRenderer entity** — Add to the game to render terrain, water, and wetness to the screen.

Query entities use GPU compute internally. Results have one frame of latency. On the first frame after a query is created, results are not yet available (the `results` array is empty).

---

## WaterQuery

Persistent entity that registers world positions for water simulation each frame and holds the results.

```typescript
class WaterQuery extends BaseEntity {
  /**
   * @param getPoints - Called each frame after physics to collect query points.
   *   Return the world-space positions you need water data for.
   *   The length can change frame-to-frame.
   */
  constructor(getPoints: () => V2d[]);

  /** The points from last frame's getPoints call. Empty until first collect. */
  readonly points: readonly V2d[];

  /** Results from last frame's GPU compute, 1:1 with points. Empty until first compute completes. */
  readonly results: readonly WaterQueryResult[];

  /** Look up the result for a specific point. Linear scan with equals(). */
  getResultForPoint(point: V2d): WaterQueryResult | undefined;

  /** Iterate over [point, result] pairs. */
  [Symbol.iterator](): Iterator<[V2d, WaterQueryResult]>;

  /**
   * Returns a promise that resolves with the first available results,
   * then destroys this query entity. Useful for one-off lookups where
   * you don't need data every frame.
   */
  getResultAndDestroy(): Promise<WaterQuery>;
}

interface WaterQueryResult {
  z: number;   // Surface elevation relative to sea level (ft)
  vx: number;  // Surface velocity X (ft/s)
  vy: number;  // Surface velocity Y (ft/s)
  vz: number;  // Surface velocity Z, i.e. dz/dt (ft/s)
}
```

### Persistent usage (every frame):

```typescript
class Boat extends BaseEntity {
  private waterQuery: WaterQuery;

  constructor() {
    super();
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.hull.vertices.map(v => this.localToWorld(v)))
    );
  }

  @on("tick")
  onTick() {
    if (this.waterQuery.results.length === 0) return; // first frame, no data yet

    // Look up by point
    const bowPos = this.localToWorld(this.hull.bowVertex);
    const bowWater = this.waterQuery.getResultForPoint(bowPos);

    // Or iterate all pairs
    for (const [point, water] of this.waterQuery) {
      // Use water.z, water.vx, water.vy, water.vz for physics
    }
  }
}
```

### One-off usage (single lookup):

```typescript
// Query water at a point, get result next frame, auto-cleanup
const query = await this.addChild(new WaterQuery(() => [spawnPosition]))
  .getResultAndDestroy();
const waterHeight = query.getResultForPoint(spawnPosition)!.z;
```

### Notes

- WaterQuery automatically registers terrain queries for its points internally. Water computation depends on terrain depth, so you don't need a separate TerrainQuery for points that already have a WaterQuery.
- `points` and `results` reflect the *previous* frame's `getPoints` call. If your point count changes between frames, be aware of this one-frame offset.

### WaterModifier

Entities that disturb the water surface (wakes, splashes, ripples) implement this interface. Modifiers are collected each frame and uploaded to the GPU.

```typescript
interface WaterModifier {
  /** Bounding box for spatial culling. */
  getBounds(): AABB;

  /** Data for GPU upload. */
  getModifierData(): WaterModifierData;
}

type WaterModifierData =
  | { type: "segment"; p1: V2d; p2: V2d; amplitude: number; falloff: number }
  | { type: "point"; center: V2d; radius: number; amplitude: number }
  | { type: "ring"; center: V2d; radius: number; width: number; amplitude: number };
```

Entities that produce water modifiers should tag themselves so the system can collect them:

```typescript
class WakeParticle extends BaseEntity implements WaterModifier {
  tags = ["waterModifier"];

  getBounds(): AABB {
    return { minX: ..., minY: ..., maxX: ..., maxY: ... };
  }

  getModifierData(): WaterModifierData {
    return {
      type: "segment",
      p1: this.trailStart,
      p2: this.trailEnd,
      amplitude: this.strength,
      falloff: this.falloffDistance,
    };
  }
}
```

---

## TerrainQuery

Persistent entity that registers world positions for terrain height lookups.

```typescript
class TerrainQuery extends BaseEntity {
  /**
   * @param getPoints - Called each frame after physics to collect query points.
   */
  constructor(getPoints: () => V2d[]);

  /** The points from last frame's getPoints call. */
  readonly points: readonly V2d[];

  /** Results from last frame's GPU compute, 1:1 with points. */
  readonly results: readonly TerrainQueryResult[];

  /** Look up the result for a specific point. Linear scan with equals(). */
  getResultForPoint(point: V2d): TerrainQueryResult | undefined;

  /** Iterate over [point, result] pairs. */
  [Symbol.iterator](): Iterator<[V2d, TerrainQueryResult]>;

  /**
   * Returns a promise that resolves with the first available results,
   * then destroys this query entity.
   */
  getResultAndDestroy(): Promise<TerrainQuery>;
}

interface TerrainQueryResult {
  height: number; // Terrain height at this point (ft). Negative = underwater.
}
```

### Persistent usage:

```typescript
class GroundedObject extends BaseEntity {
  private terrainQuery: TerrainQuery;

  constructor() {
    super();
    this.terrainQuery = this.addChild(
      new TerrainQuery(() => [this.getPosition()])
    );
  }

  @on("tick")
  onTick() {
    const result = this.terrainQuery.getResultForPoint(this.getPosition());
    if (!result) return;
    // Use result.height for collision, placement, etc.
  }
}
```

### One-off usage:

```typescript
const query = await this.addChild(new TerrainQuery(() => [position]))
  .getResultAndDestroy();
const height = query.getResultForPoint(position)!.height;
```

**Note:** You usually don't need TerrainQuery directly. WaterQuery automatically includes terrain depth in its computation. TerrainQuery is for entities that need terrain data independently of water (e.g., land-based objects, camera elevation).

---

## WindQuery

Persistent entity that registers world positions for wind lookups.

```typescript
class WindQuery extends BaseEntity {
  /**
   * @param getPoints - Called each frame after physics to collect query points.
   */
  constructor(getPoints: () => V2d[]);

  /** The points from last frame's getPoints call. */
  readonly points: readonly V2d[];

  /** Results from last frame's GPU compute, 1:1 with points. */
  readonly results: readonly WindQueryResult[];

  /** Look up the result for a specific point. Linear scan with equals(). */
  getResultForPoint(point: V2d): WindQueryResult | undefined;

  /** Iterate over [point, result] pairs. */
  [Symbol.iterator](): Iterator<[V2d, WindQueryResult]>;

  /**
   * Returns a promise that resolves with the first available results,
   * then destroys this query entity.
   */
  getResultAndDestroy(): Promise<WindQuery>;
}

interface WindQueryResult {
  vx: number; // Wind velocity X (ft/s)
  vy: number; // Wind velocity Y (ft/s)
}
```

### Persistent usage:

```typescript
class Sail extends BaseEntity {
  private windQuery: WindQuery;

  constructor() {
    super();
    this.windQuery = this.addChild(
      new WindQuery(() => [this.getPosition()])
    );
  }

  @on("tick")
  onTick() {
    const wind = this.windQuery.getResultForPoint(this.getPosition());
    if (!wind) return;
    // Use wind.vx, wind.vy for sail force calculations
  }
}
```

### Base Wind

The level-defined base wind (before spatial noise) is available without a query:

```typescript
const worldManager = this.game.entities.getById("worldManager") as WorldManager;
const baseWind = worldManager.getBaseWind();
```

---

## SurfaceRenderer

Entity that renders terrain, water, and wetness to the screen. Add one to the game to get world surface rendering.

```typescript
class SurfaceRenderer extends BaseEntity {
  constructor();
}
```

**Usage:**

```typescript
// In level setup
game.addEntity(new SurfaceRenderer());
```

That's it. SurfaceRenderer reads the camera each frame, determines the visible rect, and runs the four-pass GPU pipeline (terrain → water → wetness → composite). It reads from the same shared GPU resources that the query system uses — terrain VirtualTexture tiles, shadow VirtualTexture tiles, wave source parameters, water modifier buffer, and time uniforms.

SurfaceRenderer has no public methods. It is a self-contained rendering entity.

---

## WorldManager

Sets up the world systems (terrain, waves, wind, query infrastructure) from a level definition. This is the entry point that makes everything above work.

```typescript
class WorldManager extends BaseEntity {
  id = "worldManager";

  /**
   * @param level - The level definition containing terrain contours,
   *   wave sources, wind parameters, etc.
   */
  constructor(level: LevelDefinition);

  /** The level-defined base wind vector. */
  getBaseWind(): V2d;
}

interface LevelDefinition {
  terrain: TerrainDefinition;
  waveSources: WaveSource[];
  baseWind: { direction: number; speed: number };
  tide?: { range: number; frequency: number };
}

interface TerrainDefinition {
  contours: TerrainContour[];
  defaultDepth: number; // Deep ocean baseline (ft)
}

interface TerrainContour {
  controlPoints: readonly V2d[];
  height: number; // ft
}

interface WaveSource {
  direction: number;      // Radians, direction waves travel FROM
  baseAmplitude: number;  // Base wave height (ft)
  wavelength: number;     // Distance between crests (ft)
}
```

**Usage:**

```typescript
// Level startup
game.addEntity(new WorldManager(levelData));
game.addEntity(new SurfaceRenderer());
```

WorldManager owns and initializes:
- Terrain system (contour data, containment tree, VirtualTexture)
- Wave shadow system (shadow geometry, shadow VirtualTextures)
- Wave source parameters (GPU buffer)
- Wind system
- Query infrastructure (point buffers, compute dispatches, async readback)
- Water modifier collection (collects tagged entities each frame)

All of these are internal. Game entities interact only through the Query classes described above.

---

## Lifecycle Summary

```
Level load:
  game.addEntity(new WorldManager(levelData))  → sets up all world systems
  game.addEntity(new SurfaceRenderer())         → renders the world surface

Each frame:
  1. Physics tick
     - Entities read previous frame's results from their query objects
     - waterQuery.results, windQuery.results, terrainQuery.results

  2. After physics
     - Query entities collect points via their getPoints callbacks
     - Water modifiers collected from tagged entities

  3. GPU work
     - Upload query points
     - Terrain compute (no dependencies)
     - Water compute (depends on terrain results)
     - Wind compute (depends on terrain results)
     - Copy results to staging buffer
     - Begin async readback

  4. Render
     - SurfaceRenderer runs 4-pass pipeline using camera rect
     - Terrain pass → Water pass → Wetness pass → Composite pass

  Next frame:
     - Readback completes, results populate query objects
```

---

## Design Notes

- **One frame of latency**: Query results are always from the previous frame. This is inherent to the async GPU readback design. For 120Hz physics, one frame of latency is imperceptible.
- **Empty on first frame**: When an entity is first added, its query points haven't been computed yet. `results` is an empty array until the first readback completes.
- **No CPU fallback**: All computation is GPU-only. There is no CPU-side wave evaluation or terrain sampling.
- **WaterQuery auto-registers terrain**: You don't need a separate TerrainQuery if you already have a WaterQuery. The water compute needs terrain depth and handles this internally.
- **Modifiers are tag-based**: Entities implementing WaterModifier should use `tags = ["waterModifier"]` so the system can find them. The WorldManager collects them each frame.
- **Point-based lookup**: `getResultForPoint` uses linear scan with `V2d.equals()`. This is fine for the expected point counts (tens to low hundreds per query).
- **getResultAndDestroy**: The one-off query pattern creates a real query entity, waits for the first result, resolves with the query itself (so you can use `getResultForPoint`), and destroys it. No special system-level codepath — the query infrastructure only ever deals with query entity instances.
