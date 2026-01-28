# World Rendering System: Class Breakdown

This document provides a detailed class-by-class breakdown for implementing the world rendering and simulation system described in `docs/world-rendering-system-architecture-new.md`.

## File Organization

```
src/game/world/
├── WorldManager.ts            # Main entry point, orchestrates all systems
├── terrain/
│   ├── TerrainSystem.ts       # Internal terrain system
│   ├── TerrainDefinition.ts
│   ├── TerrainContour.ts
│   └── ContainmentTree.ts
├── water/
│   ├── WaterSystem.ts         # Internal water system
│   ├── WaveSource.ts
│   ├── WaveShadow.ts
│   ├── WaterModifier.ts       # Public interface
│   └── WaterModifierBuffer.ts
├── wind/
│   ├── WindSystem.ts          # Internal wind system
│   └── WindNoise.ts
├── query/
│   ├── QueryInfrastructure.ts # Internal coordinator
│   ├── BaseQuery.ts           # Internal base class
│   ├── TerrainQuery.ts        # Public query entity
│   ├── WaterQuery.ts          # Public query entity
│   └── WindQuery.ts           # Public query entity
├── rendering/
│   ├── SurfaceRenderer.ts     # Public rendering entity
│   ├── TerrainRenderPass.ts
│   ├── WaterRenderPass.ts
│   ├── WetnessPass.ts
│   └── CompositePass.ts
└── virtual-texture/
    ├── VirtualTexture.ts
    ├── TileCache.ts
    └── TileCompute.ts
```

**Public API (exposed to game code)**:
- `WorldManager` - Initialize world systems from level definition
- `SurfaceRenderer` - Render world to screen
- `TerrainQuery`, `WaterQuery`, `WindQuery` - Query entities for simulation data
- `WaterModifier` - Interface for entities that disturb water

**Internal implementation** (not exposed):
- TerrainSystem, WaterSystem, WindSystem - System entities owned by WorldManager
- QueryInfrastructure - GPU compute coordinator
- VirtualTexture infrastructure - LOD and caching
- Render passes - GPU compute/render pipelines

---

## Core Infrastructure Classes

### VirtualTexture&lt;T&gt; (Generic)

**File**: `src/game/world/virtual-texture/VirtualTexture.ts`

**Purpose**: LOD-aware, demand-driven caching system for large static datasets (terrain heights, wave shadow intensity). Manages a grid of tiles at multiple LOD levels with LRU eviction.

**Type parameter**: `T` determines tile data type (e.g., `TerrainHeight`, `ShadowData`)

**Public Interface**:
```typescript
class VirtualTexture<T> {
  constructor(config: VirtualTextureConfig<T>);

  // Request tiles covering a world rect at appropriate LOD
  requestTilesForRect(worldRect: Rect, worldUnitsPerPixel: number): void;

  // Get tile data (returns coarser LOD if exact tile not ready)
  getTile(worldX: number, worldY: number, lod: number): TileData<T> | null;

  // Process pending tile computations (call each frame)
  update(device: GPUDevice): void;

  // Invalidate all cached tiles (terrain edit)
  invalidate(): void;

  // Get GPU texture array for shader binding
  getTextureArray(): GPUTexture;
}

interface VirtualTextureConfig<T> {
  tileSize: number;           // 128x128 texels
  maxTiles: number;           // 512 tiles (16MB budget)
  baseWorldUnitsPerTexel: number; // LOD 0 resolution (0.5 ft)
  maxLOD: number;             // Maximum LOD level
  tileFormat: GPUTextureFormat; // r16float for terrain, rg8unorm for shadows
  computeFn: TileComputeFunction<T>; // Shader code to fill tile
}
```

**Ownership**: Created by TerrainSystem (for terrain heights) and WaveShadow instances (for shadow data)

**Notes**:
- Implements LRU eviction when cache is full
- Fallback chain: if requested LOD not ready, samples coarser LOD
- Caps tile computations per frame (4-8) to avoid stalling

---

### TileCache

**File**: `src/game/world/virtual-texture/TileCache.ts`

**Purpose**: Manages the tile storage pool, LRU eviction, and tile addressing logic for VirtualTexture.

**Public Interface**:
```typescript
class TileCache<T> {
  constructor(maxTiles: number, tileSize: number);

  // Get cached tile or null if not present
  get(lod: number, tileX: number, tileY: number): CachedTile<T> | null;

  // Allocate a slot for a new tile (evicts LRU if full)
  allocate(lod: number, tileX: number, tileY: number): TileSlot;

  // Mark tile as recently used (LRU tracking)
  touch(tile: CachedTile<T>): void;

  // Remove all tiles (invalidation)
  clear(): void;
}

interface CachedTile<T> {
  lod: number;
  tileX: number;
  tileY: number;
  textureIndex: number;  // Index in GPU texture array
  lastAccessFrame: number;
  data: T;
}
```

**Ownership**: Internal to VirtualTexture

---

### TileCompute

**File**: `src/game/world/virtual-texture/TileCompute.ts`

**Purpose**: GPU compute shader wrapper for filling VirtualTexture tiles.

**Public Interface**:
```typescript
abstract class TileCompute extends ComputeShader {
  // Dispatch compute for a single tile
  computeTile(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    tile: TileAddress,
    output: GPUTexture,
    outputLayer: number
  ): void;

  protected abstract getComputeCode(): string;
  protected abstract getBindings(): BindGroupLayout;
}

class TerrainTileCompute extends TileCompute {
  // Uses terrain contour data buffer to compute heights
}

class ShadowTileCompute extends TileCompute {
  // Uses shadow polygon geometry to rasterize shadow intensity
}
```

**Ownership**: Created by VirtualTexture instances

---

## Terrain System

### TerrainSystem (Entity)

**File**: `src/game/world/terrain/TerrainSystem.ts`

**Purpose**: Top-level terrain system entity. Manages terrain definition, containment tree, virtual texture, and query handling. Singleton entity accessed via `game.entities.getById("terrainSystem")`.

**Public Interface**:
```typescript
class TerrainSystem extends BaseEntity {
  readonly id = "terrainSystem";
  readonly tickLayer = "environment";

  constructor(definition: TerrainDefinition);

  // Get terrain info accessor
  static fromGame(game: Game): TerrainSystem;

  // Direct synchronous query (reads from cache)
  getHeightAtPoint(point: V2d): number | null;

  // Async query (goes through query infrastructure)
  getHeightAtPointAsync(point: V2d): Promise<number>;

  // Request tiles for rendering
  requestTilesForRect(worldRect: Rect, worldUnitsPerPixel: number): void;

  // Get GPU texture for shader binding
  getTerrainTexture(): GPUTexture;

  // Get coastlines for wave shadow system
  getCoastlines(): TerrainContour[];

  // Editor support: modify terrain and invalidate caches
  setDefinition(definition: TerrainDefinition): void;

  @on("tick")
  onTick(dt: number): void; // Calls virtualTexture.update()
}
```

**Entity Properties**:
- Tags: `["terrainSystem"]`
- Tick layer: `"environment"` (early in frame for GPU work)
- No physics bodies
- Children: None (but creates compute shaders internally)

---

### TerrainDefinition

**File**: `src/game/world/terrain/TerrainDefinition.ts`

**Purpose**: Data structure defining terrain via contours. Loaded from level files.

**Public Interface**:
```typescript
interface TerrainDefinition {
  contours: TerrainContour[];
  defaultDepth: number; // Deep ocean baseline (-50 ft)
}

interface TerrainContour {
  controlPoints: readonly V2d[]; // Catmull-Rom spline control points
  height: number; // Height of this contour (ft)
  isClosed: boolean; // Always true for terrain contours
}

// Serialization helpers
function serializeTerrainDefinition(def: TerrainDefinition): string;
function deserializeTerrainDefinition(json: string): TerrainDefinition;
```

**Ownership**: Created by level loader, owned by TerrainSystem

---

### ContainmentTree

**File**: `src/game/world/terrain/ContainmentTree.ts`

**Purpose**: Hierarchical representation of which contours contain which other contours. Used for efficient terrain height queries.

**Public Interface**:
```typescript
class ContainmentTree {
  constructor(contours: TerrainContour[], defaultDepth: number);

  // Find height at a point via tree traversal and interpolation
  getHeightAt(point: V2d): number;

  // Find the deepest contour containing this point
  findDeepestContaining(point: V2d): ContourNode | null;

  // Extract coastlines (height=0 contours)
  getCoastlines(): TerrainContour[];
}

interface ContourNode {
  contour: TerrainContour;
  children: ContourNode[];
  parent: ContourNode | null;
}
```

**Ownership**: Created and owned by TerrainSystem

**Notes**: Built once when terrain is loaded, rebuilt when terrain is modified

---

## Water System

### WaterSystem (Entity)

**File**: `src/game/world/water/WaterSystem.ts`

**Purpose**: Top-level water simulation entity. Manages wave sources, shadow system, modifiers, tide, and query handling. Singleton accessed via `game.entities.getById("waterSystem")`.

**Public Interface**:
```typescript
class WaterSystem extends BaseEntity {
  readonly id = "waterSystem";
  readonly tickLayer = "environment";

  constructor(config: WaterSystemConfig);

  static fromGame(game: Game): WaterSystem;

  // Synchronous query (reads from previous frame's results)
  getInfoAtPoint(point: V2d): WaterQueryResult | null;

  // Async query (returns promise resolving next frame)
  getInfoAtPointAsync(point: V2d): Promise<WaterQueryResult>;

  // Get wave sources for rendering
  getWaveSources(): WaveSource[];

  // Get shadow textures for rendering (one per wave source)
  getShadowTextures(): GPUTexture[];

  // Get water modifier buffer for rendering
  getModifierBuffer(): GPUBuffer;

  // Get current tide height (function of time)
  getTideHeight(): number;

  // Internal: update modifiers from collected entities
  updateModifiers(modifiers: WaterModifier[]): void;

  @on("tick")
  onTick(dt: number): void; // Update modifiers, collect queries
}

interface WaterSystemConfig {
  waveSources: WaveSourceConfig[];
  tideConfig: TideConfig;
  modifierBufferSize: number; // Default 16384
}

interface WaterQueryResult {
  z: number;   // Surface elevation relative to sea level (ft)
  vx: number;  // Surface velocity X (ft/s)
  vy: number;  // Surface velocity Y (ft/s)
  vz: number;  // Surface velocity Z, i.e., dz/dt (ft/s)
}
```

**Entity Properties**:
- Tags: `["waterSystem"]`
- Tick layer: `"environment"`
- Children: WaveShadow instances (one per wave source)

---

### WaveSource

**File**: `src/game/world/water/WaveSource.ts`

**Purpose**: Configuration and runtime state for a single wave source (e.g., ocean swell, wind chop).

**Public Interface**:
```typescript
class WaveSource {
  readonly direction: number;      // Radians, waves travel FROM this direction
  readonly baseAmplitude: number;  // Base wave height (ft)
  readonly wavelength: number;     // Distance between crests (ft)
  readonly k: number;              // Wave number (2π/wavelength)
  readonly omega: number;          // Angular frequency (sqrt(g*k))

  // Runtime modulation
  amplitude: number;  // Can vary without recomputing shadows

  constructor(config: WaveSourceConfig);

  // Compute Gerstner displacement at a point
  computeDisplacement(pos: V2d, time: number): V2d;

  // Compute height and velocity at a point
  evaluate(pos: V2d, time: number): { z: number; vz: number };

  // Get GPU buffer data for shader upload
  getGPUData(): WaveSourceGPUData;
}

interface WaveSourceConfig {
  direction: number;
  baseAmplitude: number;
  wavelength: number;
}
```

**Ownership**: Created by WaterSystem, stored in array

---

### WaveShadow (Entity)

**File**: `src/game/world/water/WaveShadow.ts`

**Purpose**: Manages shadow geometry and VirtualTexture for a single wave source. Child entity of WaterSystem.

**Public Interface**:
```typescript
class WaveShadow extends BaseEntity {
  constructor(
    waveDirection: number,
    coastlines: TerrainContour[]
  );

  // Get shadow virtual texture for shader binding
  getShadowTexture(): GPUTexture;

  // Request shadow tiles for a rect
  requestTilesForRect(worldRect: Rect, worldUnitsPerPixel: number): void;

  // Recompute shadow geometry (when terrain changes)
  rebuildGeometry(coastlines: TerrainContour[]): void;

  @on("tick")
  onTick(dt: number): void; // Calls virtualTexture.update()
}
```

**Entity Properties**:
- Parent: WaterSystem
- Tick layer: inherited from parent ("environment")
- Internal: VirtualTexture&lt;ShadowData&gt; instance

**Notes**: One WaveShadow entity per WaveSource. Geometry computed at level load based on wave direction and coastlines.

---

### WaterModifier (Interface)

**File**: `src/game/world/water/WaterModifier.ts`

**Purpose**: Interface for local water disturbances (wakes, splashes, ripples). Implemented by entities that create water effects.

**Public Interface**:
```typescript
interface WaterModifier {
  // Bounds for spatial culling
  getBounds(): AABB;

  // Data for GPU upload
  getModifierData(): WaterModifierData;
}

type WaterModifierData =
  | { type: "segment"; p1: V2d; p2: V2d; amplitude: number; falloff: number }
  | { type: "point"; center: V2d; radius: number; amplitude: number }
  | { type: "ring"; center: V2d; radius: number; width: number; amplitude: number };

interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

**Ownership**: Implemented by effect entities (WakeParticle, Splash, Ripple)

**Example Implementations**:
- `WakeParticle` (segment modifier)
- `Splash` (point modifier)
- `Ripple` (ring modifier with expanding radius)

**Collection**: Entities implementing WaterModifier should tag themselves with `tags = ["waterModifier"]` so WorldManager can collect them each frame via `game.entities.getTagged("waterModifier")`.

**Usage Example**:
```typescript
class WakeParticle extends BaseEntity implements WaterModifier {
  tags = ["waterModifier"];

  getBounds(): AABB {
    return {
      minX: Math.min(this.trailStart.x, this.trailEnd.x) - this.falloffDistance,
      minY: Math.min(this.trailStart.y, this.trailEnd.y) - this.falloffDistance,
      maxX: Math.max(this.trailStart.x, this.trailEnd.x) + this.falloffDistance,
      maxY: Math.max(this.trailStart.y, this.trailEnd.y) + this.falloffDistance,
    };
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

### WaterModifierBuffer

**File**: `src/game/world/water/WaterModifierBuffer.ts`

**Purpose**: Manages the GPU storage buffer for all active water modifiers. Collects modifiers each frame and uploads to GPU.

**Public Interface**:
```typescript
class WaterModifierBuffer {
  constructor(device: GPUDevice, maxModifiers: number = 16384);

  // Update buffer with current active modifiers
  update(modifiers: WaterModifier[]): void;

  // Get GPU buffer for shader binding
  getBuffer(): GPUBuffer;

  // Get active modifier count for shader uniform
  getActiveCount(): number;
}
```

**Ownership**: Created and owned by WaterSystem

**Notes**: Uploads only active portion each frame to minimize transfer overhead

---

## Wind System

### WindSystem (Entity)

**File**: `src/game/world/wind/WindSystem.ts`

**Purpose**: Top-level wind simulation entity. Currently implements simple noise-based wind with future support for terrain influence and wind shadows. Singleton accessed via `game.entities.getById("windSystem")`.

**Public Interface**:
```typescript
class WindSystem extends BaseEntity {
  readonly id = "windSystem";
  readonly tickLayer = "environment";

  constructor(config: WindSystemConfig);

  static fromGame(game: Game): WindSystem;

  // Synchronous query
  getWindAtPoint(point: V2d): WindQueryResult | null;

  // Async query
  getWindAtPointAsync(point: V2d): Promise<WindQueryResult>;

  // Get base wind (constant vector)
  getBaseWind(): V2d;

  @on("tick")
  onTick(dt: number): void;
}

interface WindSystemConfig {
  baseWind: V2d;  // Constant wind vector (direction + speed)
  noiseConfig: WindNoiseConfig;
}

interface WindQueryResult {
  vx: number;  // Wind velocity X (ft/s)
  vy: number;  // Wind velocity Y (ft/s)
}
```

**Entity Properties**:
- Tags: `["windSystem"]`
- Tick layer: `"environment"`

---

### WindNoise

**File**: `src/game/world/wind/WindNoise.ts`

**Purpose**: GPU compute shader for wind noise generation. Provides spatially-varying, time-scrolling noise for natural wind variation.

**Public Interface**:
```typescript
class WindNoise extends ComputeShader {
  constructor(config: WindNoiseConfig);

  // Compute wind at query points
  compute(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    points: GPUBuffer,
    baseWind: V2d,
    time: number,
    output: GPUBuffer
  ): void;
}

interface WindNoiseConfig {
  noiseScale: number;    // Spatial frequency (0.01)
  timeScale: number;     // Scroll speed (0.1)
  variation: number;     // ±variation% (0.2 = ±20%)
}
```

**Ownership**: Created and owned by WindSystem

---

## WorldManager (Orchestrator)

### WorldManager (Entity)

**File**: `src/game/world/WorldManager.ts`

**Purpose**: Main entry point for the world rendering and simulation system. Sets up and owns all internal systems (terrain, water, wind, query infrastructure) from a level definition. Singleton entity accessed via `game.entities.getById("worldManager")`.

**Public Interface**:
```typescript
class WorldManager extends BaseEntity {
  readonly id = "worldManager";
  readonly tickLayer = "environment";

  /**
   * @param level - The level definition containing terrain contours,
   *   wave sources, wind parameters, etc.
   */
  constructor(level: LevelDefinition);

  /** The level-defined base wind vector. */
  getBaseWind(): V2d;

  @on("tick")
  onTick(dt: number): void;
  // Collect water modifiers from tagged entities each frame
}

interface LevelDefinition {
  terrain: TerrainDefinition;
  waveSources: WaveSourceConfig[];
  baseWind: { direction: number; speed: number };
  tide?: { range: number; frequency: number };
}
```

**Entity Properties**:
- Tags: `["worldManager"]`
- Tick layer: `"environment"`
- Children: TerrainSystem, WaterSystem, WindSystem, QueryInfrastructure (all internal)

**Responsibilities**:
- Initialize terrain system (contour data, containment tree, VirtualTexture)
- Initialize wave shadow system (shadow geometry, shadow VirtualTextures)
- Initialize wave source parameters (GPU buffer)
- Initialize wind system
- Initialize query infrastructure (point buffers, compute dispatches, async readback)
- Collect water modifiers from `game.entities.getTagged("waterModifier")` each frame

**Usage**:
```typescript
// Level startup
game.addEntity(new WorldManager(levelData));
game.addEntity(new SurfaceRenderer());
```

**Notes**: All internal systems (TerrainSystem, WaterSystem, WindSystem, QueryInfrastructure) are implementation details. Game entities interact only through the Query classes (TerrainQuery, WaterQuery, WindQuery).

---

## Query Infrastructure

### QueryInfrastructure (Entity)

**File**: `src/game/world/query/QueryInfrastructure.ts`

**Purpose**: Central query coordination system. Collects query points from all entities, runs GPU compute, handles async readback. Singleton accessed via `game.entities.getById("queryInfrastructure")`.

**Public Interface**:
```typescript
class QueryInfrastructure extends BaseEntity {
  readonly id = "queryInfrastructure";
  readonly tickLayer = "environment";

  constructor(device: GPUDevice);

  static fromGame(game: Game): QueryInfrastructure;

  // Register persistent query entities
  registerQuery(query: BaseQuery): void;
  unregisterQuery(query: BaseQuery): void;

  @on("tick")
  onTick(dt: number): void;
  // 1. Map previous frame's staging buffer
  // 2. Read results and distribute to query entities
  // 3. Collect new query points from all registered queries
  // 4. Upload to GPU buffers
  // 5. Dispatch compute shaders (terrain → water → wind)
  // 6. Copy results to staging buffer
  // 7. Start async map for next frame
}
```

**Entity Properties**:
- Tags: `["queryInfrastructure"]`
- Tick layer: `"environment"` (early, to give GPU maximum time)
- Internal buffers:
  - Point buffers (terrain, water, wind)
  - Compute result buffers
  - Staging buffers A/B (double-buffered for async readback)

**Notes**: Uses double-buffered staging buffers to overlap CPU readback with GPU compute

---

### BaseQuery (Abstract Entity - Internal)

**File**: `src/game/world/query/BaseQuery.ts`

**Purpose**: Internal base class for persistent query entities (TerrainQuery, WaterQuery, WindQuery). Not exposed in public API.

**Public Interface**:
```typescript
abstract class BaseQuery extends BaseEntity {
  constructor(getPoints: () => V2d[]);

  // Public: exposed points and results arrays (readonly)
  readonly points: readonly V2d[];
  readonly results: readonly unknown[];

  // Public: look up result by point value
  getResultForPoint(point: V2d): unknown | undefined;

  // Public: make queries iterable for [point, result] pairs
  [Symbol.iterator](): Iterator<[V2d, unknown]>;

  // Public: one-off query helper
  getResultAndDestroy(): Promise<this>;

  // Internal: called by QueryInfrastructure after physics tick
  getQueryPoints(): V2d[];

  // Internal: called by QueryInfrastructure after readback
  setResults(results: unknown[]): void;

  // Internal: buffer offset assigned by QueryInfrastructure
  bufferOffset: number;
  bufferCount: number;
}
```

**Ownership**: Created as children of entities that need queries (e.g., Boat creates WaterQuery)

**Notes**:
- Uses linear scan with `V2d.equals()` for `getResultForPoint()` - fine for expected point counts
- `getResultAndDestroy()` creates query, waits for first result, resolves with the query itself, then destroys it

---

### TerrainQuery (Entity)

**File**: `src/game/world/query/TerrainQuery.ts`

**Purpose**: Persistent terrain height query entity.

**Public Interface**:
```typescript
class TerrainQuery extends BaseQuery {
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

**Usage Example (Persistent)**:
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
    if (this.terrainQuery.results.length === 0) return; // First frame

    const result = this.terrainQuery.getResultForPoint(this.getPosition());
    if (result) {
      // Use result.height for collision, placement, etc.
    }
  }
}
```

**Usage Example (One-off)**:
```typescript
const query = await this.addChild(new TerrainQuery(() => [position]))
  .getResultAndDestroy();
const height = query.getResultForPoint(position)!.height;
```

**Notes**: You usually don't need TerrainQuery directly. WaterQuery automatically includes terrain depth in its computation.

---

### WaterQuery (Entity)

**File**: `src/game/world/query/WaterQuery.ts`

**Purpose**: Persistent water simulation query entity.

**Public Interface**:
```typescript
class WaterQuery extends BaseQuery {
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
```

**Usage Example (Persistent)**:
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
    if (this.waterQuery.results.length === 0) return; // First frame, no data yet

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

**Usage Example (One-off)**:
```typescript
// Query water at a point, get result next frame, auto-cleanup
const query = await this.addChild(new WaterQuery(() => [spawnPosition]))
  .getResultAndDestroy();
const waterHeight = query.getResultForPoint(spawnPosition)!.z;
```

**Notes**:
- WaterQuery automatically registers terrain queries for its points internally. Water computation depends on terrain depth, so you don't need a separate TerrainQuery for points that already have a WaterQuery.
- `points` and `results` reflect the *previous* frame's `getPoints` call. If your point count changes between frames, be aware of this one-frame offset.

---

### WindQuery (Entity)

**File**: `src/game/world/query/WindQuery.ts`

**Purpose**: Persistent wind query entity.

**Public Interface**:
```typescript
class WindQuery extends BaseQuery {
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
```

**Usage Example (Persistent)**:
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

---

## Surface Rendering

### SurfaceRenderer (Entity)

**File**: `src/game/world/rendering/SurfaceRenderer.ts`

**Purpose**: Orchestrates the multi-pass surface rendering pipeline. Runs compute passes to generate terrain, water, and wetness textures, then composites to screen. Singleton entity.

**Public Interface**:
```typescript
class SurfaceRenderer extends BaseEntity {
  readonly id = "surfaceRenderer";
  readonly renderLayer = "water";

  constructor(device: GPUDevice);

  static fromGame(game: Game): SurfaceRenderer;

  @on("render")
  onRender({ dt, draw }: GameEventMap["render"]): void;
  // 1. Compute render rect from camera
  // 2. Run terrain pass → terrainTexture
  // 3. Run water pass → waterTexture
  // 4. Run wetness pass → wetnessTexture
  // 5. Run composite pass → screen

  // Get current render rect (for debugging/visualization)
  getRenderRect(): Rect;
}
```

**Entity Properties**:
- Tags: `["surfaceRenderer"]`
- Render layer: `"water"` (renders before boats/particles)
- Internal: TerrainRenderPass, WaterRenderPass, WetnessPass, CompositePass instances

**Notes**: Textures allocated once at screen resolution, reallocated on resize

---

### TerrainRenderPass

**File**: `src/game/world/rendering/TerrainRenderPass.ts`

**Purpose**: GPU compute pass that samples terrain VirtualTexture tiles into a dense screen-sized texture.

**Public Interface**:
```typescript
class TerrainRenderPass extends ComputeShader {
  constructor(device: GPUDevice);

  // Run terrain sampling compute
  render(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    renderRect: Rect,
    terrainTexture: GPUTexture,  // VirtualTexture from TerrainSystem
    outputTexture: GPUTexture    // rg16float (height, material)
  ): void;
}
```

**Ownership**: Created and owned by SurfaceRenderer

---

### WaterRenderPass

**File**: `src/game/world/rendering/WaterRenderPass.ts`

**Purpose**: GPU compute pass that evaluates full water simulation (waves + shadows + modifiers) for every visible texel.

**Public Interface**:
```typescript
class WaterRenderPass extends ComputeShader {
  constructor(device: GPUDevice);

  // Run water simulation compute
  render(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    renderRect: Rect,
    terrainTexture: GPUTexture,      // From terrain pass
    waveSources: WaveSource[],        // From WaterSystem
    shadowTextures: GPUTexture[],     // From WaveShadow entities
    modifierBuffer: GPUBuffer,        // From WaterModifierBuffer
    time: number,
    outputTexture: GPUTexture         // rgba16float (height, normal, foam)
  ): void;
}
```

**Ownership**: Created and owned by SurfaceRenderer

**Notes**: Most expensive pass — evaluates wave math per source, samples shadows, iterates modifiers

---

### WetnessPass

**File**: `src/game/world/rendering/WetnessPass.ts`

**Purpose**: GPU compute pass that updates wetness state using ping-pong textures. Handles viewport movement by reprojecting from previous frame's wetness texture.

**Public Interface**:
```typescript
class WetnessPass extends ComputeShader {
  constructor(device: GPUDevice);

  // Run wetness update compute
  render(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    currentRenderRect: Rect,
    previousRenderRect: Rect,
    terrainTexture: GPUTexture,      // From terrain pass
    waterTexture: GPUTexture,        // From water pass
    previousWetnessTexture: GPUTexture, // Read from this
    currentWetnessTexture: GPUTexture,  // Write to this
    dt: number
  ): void;

  // Swap ping-pong textures
  swapTextures(): void;
}
```

**Ownership**: Created and owned by SurfaceRenderer

**Notes**: Maintains two r8unorm textures that alternate read/write roles each frame

---

### CompositePass

**File**: `src/game/world/rendering/CompositePass.ts`

**Purpose**: Final fragment shader pass that combines terrain, water, and wetness data into the screen output. Applies lighting, blending, and visual effects.

**Public Interface**:
```typescript
class CompositePass {
  constructor(device: GPUDevice);

  // Run composite render
  render(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    terrainTexture: GPUTexture,
    waterTexture: GPUTexture,
    wetnessTexture: GPUTexture,
    renderRect: Rect,
    camera: Camera,
    outputTexture: GPUTextureView  // Screen render target
  ): void;
}
```

**Ownership**: Created and owned by SurfaceRenderer

**Responsibilities**:
- Terrain color (sand, grass, rock based on height)
- Wetness darkening effect
- Water surface normals (from finite differences or stored data)
- Lighting (ambient, diffuse, specular)
- Water transparency/blending (Fresnel-based)
- Foam at shoreline

---

## Compute Shader Base Classes

### ComputeShader (Base)

**File**: `src/core/graphics/webgpu/ComputeShader.ts` (already exists)

**Purpose**: Abstract base class for compute shaders. Handles pipeline, bind group layout, and dispatch boilerplate.

**Public Interface**:
```typescript
abstract class ComputeShader {
  protected abstract getComputeCode(): string;
  protected abstract getBindings(): BindGroupLayout;
  protected abstract getWorkgroupSize(): [number, number, number];

  // Implemented by subclasses
  protected createBindGroup(params: Record<string, GPUBuffer | GPUTexture>): GPUBindGroup;

  // Dispatch compute with automatic workgroup calculation
  protected dispatch(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    dispatchSize: [number, number, number]
  ): void;
}
```

**Usage**: All compute shaders (TerrainTileCompute, ShadowTileCompute, WindNoise, water/terrain render passes) extend this base class.

---

## Integration Points

### Game Initialization

In `src/game/GameController.ts`:

```typescript
class GameController extends BaseEntity {
  @on("add")
  onAdd() {
    // Load level definition
    const levelData: LevelDefinition = {
      terrain: {
        contours: [
          // Coastline contours, island contours, etc.
        ],
        defaultDepth: -50, // Deep ocean baseline
      },
      waveSources: [
        { direction: 0, baseAmplitude: 2, wavelength: 50 },
        { direction: Math.PI / 4, baseAmplitude: 1, wavelength: 20 },
      ],
      baseWind: { direction: Math.PI / 4, speed: 15 }, // 15 ft/s from NE
      tide: { range: 3, frequency: 0.0001 },
    };

    // Initialize world system
    this.addChild(new WorldManager(levelData));

    // Add surface rendering
    this.addChild(new SurfaceRenderer());

    // Spawn gameplay entities (boat, camera, etc.)
    // ...
  }
}
```

**Alternative: Load from JSON**

```typescript
@on("add")
async onAdd() {
  const levelData = await fetch("resources/levels/level1.json").then(r => r.json());
  this.addChild(new WorldManager(levelData));
  this.addChild(new SurfaceRenderer());
  // ...
}
```

---

## Summary

This class breakdown implements the architecture in `docs/world-rendering-system-architecture-new.md` and matches the public API in `docs/world-system-api.md`.

### Class Count
- **1 orchestrator class** (WorldManager) - main entry point
- **11 internal system classes** for terrain, water, wind systems
- **7 infrastructure classes** for queries, virtual textures, rendering coordination
- **3 public query classes** (TerrainQuery, WaterQuery, WindQuery)
- **5 render pass classes** for GPU rendering pipeline
- **1 public renderer** (SurfaceRenderer)

**Total: 28 classes**

### Public API (exposed to game code)
- `WorldManager` - Initialize from `LevelDefinition`
- `SurfaceRenderer` - Add for world rendering
- `TerrainQuery`, `WaterQuery`, `WindQuery` - Query entities with point-based lookup API
- `WaterModifier` - Interface for water disturbances

### Key Design Patterns
- Entity-based architecture with `@on` event handlers
- Tick layer separation ("environment" for simulation)
- Render layer separation ("water" for surface rendering)
- Singleton entities accessed via `game.entities.getById()`
- ComputeShader base class for GPU compute
- Parent-child entity hierarchy for automatic lifecycle management
- Tag-based entity collection for water modifiers

### Query API Features
- Point-based lookup with `getResultForPoint(point)`
- Iterable for `[point, result]` pairs
- `getResultAndDestroy()` for one-off queries
- One frame of latency (async GPU readback)
- Parallel `points` and `results` readonly arrays

The design is GPU-first, maintains separation between simulation and rendering, and provides a clean, ergonomic API for both persistent queries (via query entities) and one-off async queries.
