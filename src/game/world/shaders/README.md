# Shader Module Library

This directory contains reusable WGSL shader modules that can be composed into compute and render shaders. The module system replaces the previous pattern of string constants (like `SIMPLEX_NOISE_3D_WGSL`) with a more robust, dependency-aware composition system.

## Naming Convention

**One export per module, with names matching what they export:**

| Prefix    | Type      | Example                                   |
| --------- | --------- | ----------------------------------------- |
| `fn_`     | Functions | `fn_computeFresnel`, `fn_simplex3D`       |
| `struct_` | Structs   | `struct_ContourData`, `struct_WindResult` |
| `const_`  | Constants | `const_GRAVITY`, `const_MODIFIER_TYPES`   |

**Private helpers** use `_` prefix in WGSL code and stay bundled with their main function:

```wgsl
fn _simplex3D_permute(...) { ... }  // Private helper
fn simplex3D(...) { ... }           // Public function
```

This makes dependencies self-documenting - when you see `computeFresnel` in shader code, you know it came from `fn_computeFresnel`.

## Module Structure

Each module is defined in a `.wgsl.ts` file and exports exactly one thing:

```typescript
export const fn_computeFresnel: ShaderModule = {
  code: /*wgsl*/ `
    fn computeFresnel(facing: f32, power: f32) -> f32 {
      return pow(1.0 - facing, power);
    }
  `,
  dependencies: [], // Other modules this depends on
};
```

## Available Modules

### Automatic Constants

The following constants are automatically included in all shaders via `getMathConstants()`:

- `PI` (3.14159...)
- `TWO_PI` (6.28318...)
- `HALF_PI` (1.57079...)
- `GRAVITY` (32.174 ft/s²)

No need to import or depend on these - they're always available.

### Core Utilities

#### `noise.wgsl.ts`

- **fn_simplex3D** - 3D simplex noise, returns [-1, 1]
- **fn_fractalNoise3D** - Multi-octave fractal noise
- **fn_worley2D** - 2D Worley/cellular noise

#### `math.wgsl.ts`

- **fn_hash21** - 2D → 1D hash function for procedural noise

#### `coordinates.wgsl.ts`

- **fn_uvToWorld** - Convert UV (0-1) to world coordinates
- **fn_worldToUV** - Convert world to UV coordinates
- **fn_uvInBounds** - Check if UV is in valid range (0-1)

### Lighting

Per-frame sun and sky values (direction + color) are computed on the CPU by
the `TimeOfDay` entity and pushed to every lighting-aware shader as uniform
fields. See `src/game/time/SceneLighting.ts` for the shared field set used
across uniform structs.

#### `lighting.wgsl.ts`

- **fn_waterSurfaceLight** - Complete water surface shading: Fresnel mix of
  transmitted light and sky reflection, plus direct sun specular. Takes sun
  direction, sun color, and sky color as explicit parameters (supplied from
  the caller's uniform buffer).

### Geometry

#### `polygon.wgsl.ts`

- **fn_pointLeftOfSegment** - Winding number test (cross product sign)
- **fn_isInsidePolygon** - Winding number containment test for arbitrary polygons
- **fn_isInsidePolygonWithBBox** - Containment test with an early-out bbox check
- **fn_pointToLineSegmentDistanceSq** - Squared distance from point to line segment
- **fn_distanceToPolygonBoundary** - Minimum distance from a point to a polygon boundary

### Waves

#### `wave-constants.wgsl.ts`

- **const_MAX_WAVE_SOURCES** - Maximum wave source count (shared between CPU and GPU)

#### `gerstner-wave.wgsl.ts`

- **fn_calculateGerstnerWaves** - Analytical Gerstner wave computation (accepts per-wave energy factors, phase corrections)

#### `mesh-packed.wgsl.ts`

Accessor functions for reading wavefront mesh data from a single packed `array<u32>` buffer.

- **struct_MeshHeader** - Per-wave mesh metadata struct
- **struct_MeshLookupResult** - Result of a mesh lookup (energy, direction, phase, etc.)
- **fn_getMeshNumWaves**, **fn_getMeshHeader**, **fn_getMeshVertexPos**,
  **fn_getMeshVertexAttribs**, **fn_getMeshTriangle**, **fn_getMeshGridCell**,
  **fn_getMeshGridTriIndex** - Buffer accessors
- **fn_barycentric** - Barycentric interpolation helper
- **fn_lookupMeshForWave** - Full mesh lookup with spatial grid + barycentric interpolation

### Terrain

The terrain modules are split across three files for clarity:

#### `terrain-packed.wgsl.ts`

Accessor functions for reading terrain data from a single packed `array<u32>` buffer.

- **struct_ContourData** - Contour data structure
- **fn_getTerrainVertex** - Read a vertex (vec2<f32>) from the packed buffer
- **fn_getContourData** - Read a `ContourData` struct from the packed buffer
- **fn_getTerrainChild** - Read a child contour index from the packed buffer
- **fn_getContainmentCellFlag** - Read a containment-grid cell flag
- **fn_getIDWGridCandidateRange**, **fn_getIDWGridEntry** - IDW candidate-edge grid accessors
- **fn_getLookupGridBaseContour**, **fn_getLookupGridCandidateRange**,
  **fn_getLookupGridCandidate** - Per-contour lookup-grid accessors

#### `terrain-idw.wgsl.ts`

- **fn_computeIDWWeight** - Inverse-distance-weighting weight
- **fn_blendIDW** - Blend values via IDW

#### `terrain-containment.wgsl.ts`

- **fn_isInsideContour** - Fast containment test (winding number only)
- **fn_computeDistanceToBoundary** - Minimum distance to contour boundary
- **fn_computeSignedDistance** - Signed distance to contour
- **struct_BoundaryDistanceGradient** - Distance + gradient struct
- **fn_computeDistanceToBoundaryWithGradient** - Distance and gradient in a single pass

#### `terrain.wgsl.ts`

High-level terrain field functions; pulls in the IDW and containment modules.

- **fn_computeTerrainHeight** - Terrain height via IDW interpolation between contour levels
- **fn_computeTerrainHeightAndGradient** - Height plus analytical gradient
- **fn_computeTerrainNormal** - Terrain normal from the gradient

#### `terrain-rendering.wgsl.ts`

- **fn_renderTerrain** - Land/sand/sky composite for the terrain composite pass

### Wind

#### `wind.wgsl.ts`

- **fn_calculateWindVelocity** - Wind velocity with noise variation
- **struct_WindResult** - Wind query result (velocity, speed, direction)
- **fn_computeWindAtPoint** - Full wind state at a point

#### `wind-mesh-packed.wgsl.ts`

Accessor functions for reading the wind mesh from a packed `array<u32>` buffer (analogous to `mesh-packed.wgsl.ts` for waves).

- **struct_WindMeshSourceHeader**, **struct_WindMeshLookupResult**
- **fn_getWindMeshSourceHeader**, **fn_getWindMeshVertexPos**,
  **fn_getWindMeshVertexAttribs**, **fn_getWindMeshTriangle**,
  **fn_getWindMeshGridCell**, **fn_getWindMeshGridTriIndex**
- **fn_lookupWindMeshForSource** - Single-source mesh lookup
- **fn_lookupWindMeshBlended** - Multi-source blended lookup

### Water

#### `water.wgsl.ts`

- **struct_WaveSource** - Wave source data
- **struct_WaterParams** - Water parameters
- **fn_calculateWaterData** - Water surface data
- **struct_WaterResult** - Water query result
- **fn_computeWaterHeightAtPoint** - Water height without normal
- **fn_computeWaterNormal** - Water normal via finite differences
- **fn_computeWaterAtPoint** - Full water state at a point

### Common

#### `common.wgsl.ts`

- **struct_QueryPoint** - Query point structure for GPU queries

## Usage Example

```typescript
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import { fn_uvToWorld } from "../world/shaders/coordinates.wgsl";

const myModule: ShaderModule = {
  code: /*wgsl*/ `
    fn myFunction(uv: vec2<f32>) -> f32 {
      let worldPos = uvToWorld(uv, ...);  // From fn_uvToWorld
      let noise = simplex3D(vec3(worldPos, 0.0));  // From fn_simplex3D
      return noise;
    }
  `,
  dependencies: [fn_uvToWorld, fn_simplex3D],
};
```

Dependencies are automatically resolved - if `fn_simplex3D` has its own dependencies (like private helpers), they're included automatically.

## Benefits

1. **Self-documenting dependencies** - Module names match their exports
2. **Clear import origin** - When you see `computeFresnel`, you know it's from `fn_computeFresnel`
3. **One export per module** - Easy to find what you need
4. **Automatic deduplication** - Shared dependencies are only included once
5. **Type-safe imports** - TypeScript ensures correct module references
