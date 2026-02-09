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

- **fn_simplex3D** - 3D simplex noise
  - `simplex3D(v: vec3<f32>) -> f32` - Returns [-1, 1]
  - Private helpers: `_simplex3D_mod289_vec3`, `_simplex3D_permute`, etc.

#### `math.wgsl.ts`

- **fn_hash21** - Hash function for procedural noise
  - `hash21(p: vec2<f32>) -> f32` - 2D → 1D hash

#### `coordinates.wgsl.ts`

- **fn_uvToWorld** - Convert UV (0-1) to world coordinates
- **fn_worldToUV** - Convert world to UV coordinates
- **fn_uvInBounds** - Check if UV is in valid range (0-1)

### Lighting

#### `scene-lighting.wgsl.ts`

- **fn_SCENE_LIGHTING** - Global sun direction and color functions based on time of day
  - `getSunDirection(time)` - Calculate sun direction from time (0-86400 seconds)
  - `getSunColor(time)` - Calculate sun color from time (warm at sunrise/sunset, bright at midday)
  - `getSkyColor(time)` - Calculate sky color from time (purple at dawn/dusk, blue at midday)

#### `lighting.wgsl.ts`

- **fn_computeFresnel** - Fresnel effect (Schlick approximation)
- **fn_computeSpecular** - Phong specular reflection
- **fn_computeDiffuse** - Lambertian diffuse lighting
- **fn_renderWaterLighting** - Complete water surface shading
  - Dependencies: `fn_SCENE_LIGHTING`, `fn_computeFresnel`, `fn_computeSpecular`, `fn_computeDiffuse`

### Physics

#### `wave-physics.wgsl.ts`

- **fn_computeShoalingFactor** - Green's Law wave shoaling
- **fn_computeShallowDamping** - Bottom friction damping
- **fn_computeWaveFrequency** - Wave angular frequency from wavelength
- **fn_computeWaveNumber** - Wave number from wavelength

#### `gerstner-wave.wgsl.ts`

- **fn_calculateGerstnerWaves** - Analytical Gerstner wave computation (accepts per-wave energy factors)

#### `fresnel-diffraction.wgsl.ts`

- **fn_computeFresnelEnergy** - Wave energy attenuation from Fresnel diffraction

#### `shadow-attenuation.wgsl.ts`

- **struct_ShadowData** - Shadow data structures (`PolygonShadowData`)
- **fn_computeShadowEnergyForWave** - Per-wave shadow energy attenuation using that wave's direction and wavelength
  - Dependencies: `fn_computeFresnelEnergy`, `fn_getShadowNumWaves`, `fn_getShadowWaveSetOffset`, `fn_getShadowWaveDirAt`, `fn_getShadowPolygonCountAt`, `fn_getShadowVerticesOffsetAt`, `fn_getShadowPolygon`, `fn_isInsideShadowPolygon`

### Terrain

#### `terrain.wgsl.ts`

- **fn_pointToLineSegmentDistanceSq** - Squared distance from point to segment
- **fn_pointLeftOfSegment** - Winding number test
- **fn_computeIDWWeight** - Inverse distance weighting weight
- **fn_blendIDW** - Blend values using IDW
- **struct_ContourData** - Contour data structure
- **fn_isInsideContour** - Fast containment test (winding number only)
  - Dependencies: `fn_pointLeftOfSegment`, `struct_ContourData`, `fn_getContourData`, `fn_getTerrainVertex`
- **fn_computeDistanceToBoundary** - Minimum distance to contour boundary
  - Dependencies: `fn_pointToLineSegmentDistanceSq`, `struct_ContourData`, `fn_getContourData`, `fn_getTerrainVertex`
- **fn_computeSignedDistance** - Signed distance to contour
  - Dependencies: `fn_isInsideContour`, `fn_computeDistanceToBoundary`
- **fn_computeTerrainHeight** - Terrain height using IDW interpolation
  - Dependencies: `fn_isInsideContour`, `fn_computeDistanceToBoundary`, `fn_getContourData`, `fn_getTerrainChild`
- **fn_computeTerrainNormal** - Terrain normal via finite differences
  - Dependencies: `fn_computeTerrainHeight`

#### `terrain-packed.wgsl.ts`

Accessor functions for reading terrain data from a single packed `array<u32>` buffer.

- **fn_getTerrainVertex** - Read a vertex (vec2<f32>) from the packed buffer
- **fn_getContourData** - Read a ContourData struct from the packed buffer
  - Dependencies: `struct_ContourData`
- **fn_getTerrainChild** - Read a child contour index from the packed buffer

### Shadow

#### `shadow-packed.wgsl.ts`

Accessor functions for reading per-wave-source shadow data from a single packed `array<u32>` buffer. The buffer has a global header with wave source count and per-wave-set offsets, then per-wave polygon sets each with their own direction, polygon count, and vertex data.

- **fn_getShadowNumWaves** - Read number of wave sources from packed shadow buffer
- **fn_getShadowWaveSetOffset** - Read the offset to a wave source's polygon set
- **fn_getShadowWaveDirAt** - Read wave direction for a specific wave source
- **fn_getShadowPolygonCountAt** - Read polygon count for a specific wave source
- **fn_getShadowVerticesOffsetAt** - Read vertices offset for a specific wave source
- **fn_getShadowPolygon** - Read a PolygonShadowData struct from packed buffer (parameterized by set base offset)
  - Dependencies: `struct_ShadowData`
- **fn_getShadowVertex** - Read a shadow vertex from packed buffer (parameterized by vertices offset)
- **fn_isInsideShadowPolygon** - Winding number test using packed vertex data
  - Dependencies: `fn_pointLeftOfSegment`, `fn_getShadowVertex`

### Wind

#### `wind.wgsl.ts`

- **fn_calculateWindVelocity** - Wind velocity with noise variation
  - Dependencies: `fn_simplex3D`
- **struct_WindResult** - Wind query result (velocity, speed, direction)
- **fn_computeWindAtPoint** - Full wind state at a point
  - Dependencies: `struct_WindResult`, `fn_calculateWindVelocity`

### Water

#### `water.wgsl.ts`

- **struct_WaveSource** - Wave source data (placeholder)
- **struct_WaterParams** - Water parameters (placeholder)
- **fn_calculateWaterData** - Water surface data (placeholder)
- **struct_WaterResult** - Water query result
- **fn_computeWaterHeightAtPoint** - Water height without normal
  - Dependencies: `fn_calculateGerstnerWaves`
- **fn_computeWaterNormal** - Water normal via finite differences
  - Dependencies: `fn_simplex3D`, `fn_computeWaterHeightAtPoint`
- **fn_computeWaterAtPoint** - Full water state at a point
  - Dependencies: `struct_WaterResult`, `fn_simplex3D`, `fn_computeWaterHeightAtPoint`, `fn_computeWaterNormal`

#### `water-modifiers.wgsl.ts`

- **fn_computeWakeContribution** - Wake modifier
- **fn_computeRippleContribution** - Ripple modifier
- **fn_computeCurrentContribution** - Current modifier
- **fn_computeObstacleContribution** - Obstacle modifier
- **const_MODIFIER_TYPES** - Modifier type constants
- **fn_getModifierContribution** - Type-discriminating modifier dispatch
  - Dependencies: `fn_computeWakeContribution`, `fn_computeRippleContribution`, etc.
- **fn_calculateModifiers** - Accumulate all modifier contributions
  - Dependencies: `fn_getModifierContribution`

### Rendering

#### `normal-computation.wgsl.ts`

- **fn_computeNormalFromHeightField** - Normal from height texture gradients

#### `sand-rendering.wgsl.ts`

- **fn_renderSand** - Sand surface with wetness

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

## Testing

Test shaders using the module system:

- `src/game/world/shaders/test-module-system.ts` - Demonstrates composition and dependency resolution
