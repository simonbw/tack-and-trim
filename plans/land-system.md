# Land System Implementation Plan

## Overview

Add a terrain/land system to the sailing game that enables "Beginner's Bay" - a protected area for learning. The system uses a heightmap-like approach where terrain elevation is the fundamental data, and water depth is derived from `water_surface - terrain_elevation`.

## Current State

### Relevant Existing Files

- `src/game/water/WaterInfo.ts` - Water physics data provider with `getStateAtPoint()` API
- `src/game/water/rendering/WaterShader.ts` - WGSL shader for water surface rendering
- `src/game/water/rendering/WaterRenderer.ts` - Entity that runs the water shader
- `src/game/water/rendering/WaterRenderPipeline.ts` - GPU compute pipeline for water data
- `src/game/boat/Hull.ts` - Hull physics with skin friction
- `src/game/boat/Keel.ts` - Keel foil physics, queries water velocity
- `src/game/boat/Boat.ts` - Main boat entity, owns all boat components
- `src/game/fluid-dynamics.ts` - Force application functions (`applySkinFriction`, etc.)
- `src/config/layers.ts` - Render layer definitions
- `src/game/GameController.ts` - Game initialization, entity spawning

### Current Architecture

1. **Water queries**: `WaterInfo.getStateAtPoint(pos)` returns `{ velocity, surfaceHeight, surfaceHeightRate }`
2. **Boat physics**: Hull applies skin friction, Keel/Rudder apply foil forces based on water velocity
3. **Water rendering**: GPU compute shader generates height texture, fragment shader renders with Fresnel/subsurface lighting
4. **Layers**: Rendered bottom-to-top: water → waterShader → wake → ... → hull → ...

---

## Desired Changes

### Goal

Add terrain that:
1. Defines land masses and underwater topography
2. Renders sand/beach beneath transparent shallow water
3. Causes boats to slow down and stop when grounding in shallow water
4. Creates a protected "Beginner's Bay" for the tutorial

### Key Design Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Data format | Polygon-based with distance fields | Resolution-independent, easy to author |
| Collision | Soft grounding via drag forces | Forgiving gameplay, realistic sailing |
| Rendering | Land layer below water, depth-based water alpha | Clean integration with existing shaders |
| Map definition | Code-defined initially | Simple to iterate, no tooling needed |

---

## Files to Modify

### New Files

```
src/game/terrain/
├── TerrainInfo.ts          - Terrain data provider (elevation queries)
├── TerrainRenderer.ts      - Renders land polygons on "land" layer
├── GroundingSystem.ts      - Applies grounding drag to boat hull
├── maps/
│   └── BeginnersBay.ts     - Map definition for starter area
└── index.ts                - Barrel export
```

### Modified Files

```
src/config/layers.ts                    - Add "land" layer before "water"
src/game/GameController.ts              - Spawn TerrainInfo, TerrainRenderer, GroundingSystem
src/game/water/rendering/WaterShader.ts - Add depth-based alpha, sample terrain
src/game/water/rendering/WaterRenderer.ts - Pass terrain data to shader
src/game/boat/Boat.ts                   - Add GroundingSystem as child entity
```

---

## Execution Order

### Phase 1: Core Terrain Data (can be done in parallel)

These have no dependencies on each other:

#### 1A. Create TerrainInfo entity
**File**: `src/game/terrain/TerrainInfo.ts`

```typescript
// Core terrain data provider - similar pattern to WaterInfo
export interface TerrainQuery {
  elevation: number;      // Terrain height in feet (positive = above water)
  distanceToShore: number; // Distance to nearest shoreline (positive = in water)
}

export interface LandMass {
  id: string;
  coastline: V2d[];           // Polygon vertices defining shoreline
  peakElevation: number;      // Max elevation at center (feet)
  underwaterSlope: number;    // How steeply it drops off (ft/ft)
  baseDepth: number;          // Depth at coastline edge
}

export class TerrainInfo extends BaseEntity {
  id = "terrainInfo";

  private landMasses: LandMass[] = [];

  // Register a land mass
  addLandMass(landMass: LandMass): void;

  // Query terrain at a point
  queryTerrain(point: V2d): TerrainQuery;

  // Get water depth (convenience method)
  // Returns: waterSurfaceHeight - terrainElevation
  getWaterDepth(point: V2d, waterSurfaceHeight: number): number;

  // Get all land masses (for rendering)
  getLandMasses(): readonly LandMass[];
}
```

**Implementation details:**
- Use signed distance to polygon for `distanceToShore`
- Elevation profile: `peakElevation` at center, lerp to `baseDepth` at coastline, then `baseDepth - distance * underwaterSlope` beyond
- Can use existing `V2d` utilities and simplex noise for variation

#### 1B. Create BeginnersBay map definition
**File**: `src/game/terrain/maps/BeginnersBay.ts`

```typescript
export const BeginnersBay: LandMass = {
  id: "beginners-bay-shore",
  coastline: [
    // Semi-circular bay with narrow entrance
    // Coordinates in feet, origin at boat spawn
    V(-200, -150),  // Southwest corner
    V(-250, -50),   // West bulge
    V(-200, 100),   // Northwest
    V(-100, 150),   // North shore
    V(0, 130),      // North point
    V(100, 150),    // Northeast
    V(200, 100),    // East shore
    V(250, -50),    // East bulge
    V(200, -150),   // Southeast corner
    // Narrow channel opening
    V(150, -180),   // Channel east
    V(-150, -180),  // Channel west (creates narrow gap)
  ],
  peakElevation: 8,      // 8 feet above water at highest
  underwaterSlope: 0.15, // Gentle slope underwater
  baseDepth: -3,         // 3 feet deep at shoreline
};

// Deep water surrounding the bay
export const OpenOcean: LandMass = {
  id: "ocean-floor",
  coastline: [], // Empty = everywhere not covered by other land
  peakElevation: -50,
  underwaterSlope: 0,
  baseDepth: -50,
};
```

#### 1C. Add "land" layer to layer config
**File**: `src/config/layers.ts`

Add `land` layer as the first layer (rendered below everything):

```typescript
export const LAYERS = {
  // Rendered first (on the bottom)
  land: new LayerInfo(),      // NEW - terrain/sand beneath water
  water: new LayerInfo(),
  waterShader: new LayerInfo({ parallax: V(0, 0) }),
  // ... rest unchanged
}
```

#### 1D. Create barrel export
**File**: `src/game/terrain/index.ts`

```typescript
export { TerrainInfo, type TerrainQuery, type LandMass } from "./TerrainInfo";
export { TerrainRenderer } from "./TerrainRenderer";
export { GroundingSystem } from "./GroundingSystem";
export { BeginnersBay, OpenOcean } from "./maps/BeginnersBay";
```

---

### Phase 2: Rendering (depends on Phase 1A, 1B, 1C)

#### 2A. Create TerrainRenderer entity
**File**: `src/game/terrain/TerrainRenderer.ts`

```typescript
export class TerrainRenderer extends BaseEntity {
  id = "terrainRenderer";
  layer = "land" as const;

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const terrain = TerrainInfo.fromGame(this.game!);

    for (const landMass of terrain.getLandMasses()) {
      if (landMass.coastline.length < 3) continue;

      // Render filled polygon with sandy color
      draw.fillPolygon(landMass.coastline, {
        color: 0xc2a878,  // Sandy tan
      });

      // Optional: Add noise-based color variation
      // Could use a second pass with slightly different colors
    }
  }
}
```

**Future enhancement**: GPU-based terrain rendering with noise texture for more detailed sand appearance.

#### 2B. Modify water shader for depth-based transparency
**File**: `src/game/water/rendering/WaterShader.ts`

Add terrain elevation uniform and modify fragment shader:

```wgsl
// In Uniforms struct, add:
terrainDataEnabled: i32,

// In fragment shader, add depth-based alpha:
// After computing final color...

// Get terrain elevation (passed via uniform or separate texture)
let terrainElevation = /* query terrain somehow */;
let waterDepth = rawHeight - terrainElevation; // Simplified

// Visibility depth - water becomes opaque at this depth
let visibilityDepth = 8.0; // feet

// Alpha based on depth
var alpha = 1.0;
if (waterDepth < visibilityDepth) {
  alpha = clamp(waterDepth / visibilityDepth, 0.0, 1.0);
}

// Don't render water over land
if (waterDepth <= 0.0) {
  alpha = 0.0;
}

return vec4<f32>(color, alpha);
```

**Implementation approach options:**

**Option A - CPU terrain texture (simpler)**:
- Generate a terrain elevation texture on CPU each frame
- Pass to shader as additional binding
- Sample terrain elevation per pixel

**Option B - Analytical in shader (more complex but no texture overhead)**:
- Pass coastline polygon data to shader via uniform buffer
- Compute signed distance and elevation analytically
- More complex shader, but no texture memory

**Recommended: Start with Option A**, can optimize to Option B later if needed.

#### 2C. Modify WaterRenderer to pass terrain data
**File**: `src/game/water/rendering/WaterRenderer.ts`

- Query `TerrainInfo` for current viewport
- Generate terrain elevation texture or uniform data
- Pass to `WaterShader` before rendering

---

### Phase 3: Boat Grounding Physics (depends on Phase 1A)

#### 3A. Create GroundingSystem component
**File**: `src/game/terrain/GroundingSystem.ts`

```typescript
// Grounding physics constants
const BOAT_DRAFT = 2.5;        // How deep the boat sits (feet)
const KEEL_DRAFT = 3.5;        // How deep the keel goes (feet)
const GROUNDING_DRAG_SCALE = 50; // Drag multiplier when grounded
const SOFT_GROUNDING_RANGE = 1;  // Feet of "soft" grounding before full stop

export class GroundingSystem extends BaseEntity {
  tickLayer = "environment" as const;

  private hull: DynamicBody;
  private hullVertices: V2d[];

  constructor(private boat: Boat) {
    super();
    this.hull = boat.hull.body;
    this.hullVertices = boat.config.hull.vertices;
  }

  @on("tick")
  onTick() {
    const terrain = TerrainInfo.fromGame(this.game!);
    const water = WaterInfo.fromGame(this.game!);

    // Sample depth at multiple hull points
    const samplePoints = this.getHullSamplePoints();

    let totalGroundingForce = V(0, 0);
    let groundingCount = 0;

    for (const localPoint of samplePoints) {
      const worldPoint = this.hull.toWorldFrame(localPoint);
      const waterState = water.getStateAtPoint(worldPoint);
      const depth = terrain.getWaterDepth(worldPoint, waterState.surfaceHeight);

      // Check if this point is grounding
      const clearance = depth - KEEL_DRAFT;

      if (clearance < SOFT_GROUNDING_RANGE) {
        // Calculate grounding severity (0 = just touching, 1 = fully grounded)
        const severity = Math.min(1, (SOFT_GROUNDING_RANGE - clearance) / SOFT_GROUNDING_RANGE);

        // Apply drag force opposing velocity
        const velocity = this.hull.getVelocityAtPoint(worldPoint);
        const dragForce = velocity.mul(-GROUNDING_DRAG_SCALE * severity);

        totalGroundingForce.iadd(dragForce);
        groundingCount++;
      }
    }

    if (groundingCount > 0) {
      // Average and apply the grounding force
      this.hull.applyForce(totalGroundingForce.mul(1 / groundingCount));

      // Also apply angular damping to prevent spinning when grounded
      this.hull.angularVelocity *= 0.95;
    }
  }

  private getHullSamplePoints(): V2d[] {
    // Sample bow, stern, and midship port/starboard
    // Plus the keel endpoints
    return [
      V(9, 0),    // Bow
      V(-6, 0),   // Stern
      V(0, 3),    // Port midship
      V(0, -3),   // Starboard midship
      V(0, 0),    // Center (keel)
    ];
  }
}
```

#### 3B. Add GroundingSystem to Boat
**File**: `src/game/boat/Boat.ts`

In the `Boat` constructor, after creating other components:

```typescript
// Add grounding physics
this.addChild(new GroundingSystem(this));
```

Also add import at top of file.

---

### Phase 4: Integration (depends on all above)

#### 4A. Update GameController to spawn terrain
**File**: `src/game/GameController.ts`

In `onAdd()`, after spawning water systems:

```typescript
// Spawn terrain system
const terrainInfo = this.game!.addEntity(new TerrainInfo());
terrainInfo.addLandMass(BeginnersBay);
this.game!.addEntity(new TerrainRenderer());
```

Add imports at top:
```typescript
import { TerrainInfo, TerrainRenderer, BeginnersBay } from "./terrain";
```

---

## Implementation Notes

### Signed Distance to Polygon

For `distanceToShore`, implement point-to-polygon signed distance:

```typescript
function signedDistanceToPolygon(point: V2d, polygon: V2d[]): number {
  // Positive = outside polygon (in water)
  // Negative = inside polygon (on land)

  let minDist = Infinity;
  let inside = false;

  // Check each edge
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];

    // Distance to edge
    const dist = pointToSegmentDistance(point, a, b);
    minDist = Math.min(minDist, dist);

    // Ray casting for inside/outside
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }

  return inside ? -minDist : minDist;
}
```

### Terrain Elevation Profile

```typescript
function getElevation(distanceToShore: number, landMass: LandMass): number {
  if (distanceToShore < 0) {
    // On land - lerp from base to peak based on how far inland
    const inlandDistance = -distanceToShore;
    const maxInland = 50; // Assume peak is 50ft from shore
    const t = Math.min(1, inlandDistance / maxInland);
    return lerp(landMass.baseDepth, landMass.peakElevation, t);
  } else {
    // In water - slope down from baseDepth
    return landMass.baseDepth - distanceToShore * landMass.underwaterSlope;
  }
}
```

### Water Shader Alpha Blending

The water shader currently returns `vec4<f32>(color, 1.0)`. To enable transparency:

1. Update the render pipeline to enable alpha blending
2. Modify fragment shader to compute and return alpha
3. Ensure land layer renders before water layer (already handled by layer order)

---

## Testing Strategy

1. **Phase 1 complete**: `TerrainInfo.queryTerrain()` returns sensible values for points inside/outside/near coastline
2. **Phase 2 complete**: Sand is visible, water is transparent over shallow areas, opaque over deep
3. **Phase 3 complete**: Boat slows when entering shallow water, stops when fully grounded
4. **Phase 4 complete**: Can sail around Beginner's Bay, exit through channel to open ocean

---

## Future Enhancements (not in this plan)

- Wind blocking by land masses
- Beach texturing with noise/detail
- Multiple terrain types (sand, rock, grass)
- Map editor or external definition format
- GPU-based terrain rendering with procedural detail
- Collision with hard obstacles (rocks, docks)
