# Shader Module Library

This directory contains reusable WGSL shader modules that can be composed into compute and render shaders. The module system replaces the previous pattern of string constants (like `SIMPLEX_NOISE_3D_WGSL`) with a more robust, dependency-aware composition system.

## Module Structure

Each module is defined in a `.wgsl.ts` file and exports one or more `ShaderModule` objects:

```typescript
export const myModule: ShaderModule = {
  code: /*wgsl*/`...WGSL code...`,
  bindings?: {...},           // Optional GPU bindings
  dependencies?: [...]        // Optional module dependencies
};
```

## Available Modules

### Core Utilities

#### `noise.wgsl.ts`
- **simplexNoise3DModule** - 3D simplex noise function
  - `simplex3D(v: vec3<f32>) -> f32` - Returns [-1, 1]
  - Helper functions prefixed with `simplex3D_` to avoid conflicts
  - Replaces the old `SIMPLEX_NOISE_3D_WGSL` string constant

#### `math.wgsl.ts`
- **hashModule** - Hash functions for procedural noise
  - `hash21(p: vec2<f32>) -> f32` - 2D → 1D hash
- **mathConstantsModule** - Common math constants
  - `PI`, `TWO_PI`, `HALF_PI`

#### `coordinates.wgsl.ts`
- **viewportModule** - Viewport coordinate conversions
  - `uvToWorld(...)` - Convert UV (0-1) to world coordinates
  - `worldToUV(...)` - Convert world to UV coordinates
  - `uvInBounds(uv)` - Check if UV is in valid range (0-1)

### Lighting

#### `lighting.wgsl.ts`
- **fresnelModule** - Fresnel effect calculation
  - `computeFresnel(facing, power) -> f32`
- **specularModule** - Phong specular lighting
  - `computeSpecular(viewDir, normal, lightDir, shininess) -> f32`
- **diffuseModule** - Lambertian diffuse lighting
  - `computeDiffuse(normal, lightDir) -> f32`
- **waterLightingModule** - Complete water surface shading
  - `renderWaterLighting(normal, viewDir, rawHeight, waterDepth) -> vec3<f32>`
  - Dependencies: fresnelModule, specularModule, diffuseModule

### Physics

#### `wave-physics.wgsl.ts`
- **wavePhysicsConstantsModule** - Physical constants
  - `GRAVITY` - 32.174 ft/s²
- **shoalingModule** - Green's Law wave shoaling
  - `computeShoalingFactor(waterDepth, wavelength) -> f32`
- **shallowDampingModule** - Bottom friction damping
  - `computeShallowDamping(waterDepth) -> f32`
- **waveDispersionModule** - Wave frequency calculation
  - `computeWaveFrequency(wavelength) -> f32`
  - `computeWaveNumber(wavelength) -> f32`

### Domain-Specific

#### `terrain.wgsl.ts`
- **catmullRomModule** - Catmull-Rom spline evaluation
  - `catmullRomPoint(p0, p1, p2, p3, t) -> vec2<f32>`
- **distanceModule** - Distance calculation utilities
  - `pointToLineSegmentDistance(p, a, b) -> f32`
  - `pointLeftOfSegment(a, b, p) -> f32` - Winding number test
- **idwModule** - Inverse Distance Weighting interpolation
  - `computeIDWWeight(distance, minDist) -> f32`
  - `blendIDW(value1, weight1, value2, weight2) -> f32`
- **terrainHeightCoreModule** - Signed distance computation
  - `computeSignedDistance(...)` - Full terrain height calculation
  - Dependencies: catmullRomModule, distanceModule
- **terrainStructuresModule** - Data structures
  - `ContourData` struct definition

#### `wind.wgsl.ts`
- **windVelocityModule** - Wind velocity with noise variation
  - `calculateWindVelocity(...) -> vec2<f32>` - Full wind calculation with terrain influence
  - Dependencies: simplexNoise3DModule, mathConstantsModule

#### `water.wgsl.ts`
- **waterDataModule** - Water surface data calculation (placeholder)
  - Will contain Gerstner wave calculations
  - Dependencies: terrainHeightCoreModule, terrainStructuresModule

## Converted Shaders

The following shaders have been migrated to use the module system:

### ✅ WindStateShader
**Location:** `src/game/world-data/wind/webgpu/WindStateShader.ts`

**Before:** Used `SIMPLEX_NOISE_3D_WGSL` string constant and inline coordinate conversion
**After:** Uses `windVelocityModule` and `viewportModule`

**Modules used:**
- `windVelocityModule` - Provides `calculateWindVelocity()`
- `viewportModule` - Provides `uvToWorld()`

**Benefits:**
- Eliminated ~80 lines of duplicated simplex noise code
- Eliminated ~20 lines of duplicated coordinate conversion code
- Wind calculation logic now reusable in other shaders
- Automatic dependency resolution (simplex noise + math constants)

### ✅ WetnessStateShader
**Location:** `src/game/surface-rendering/WetnessStateShader.ts`

**Before:** Inline coordinate conversion functions
**After:** Uses `viewportModule`

**Modules used:**
- `viewportModule` - Provides `uvToWorld()`, `worldToUV()`, `inBounds()`

**Benefits:**
- Eliminated ~25 lines of duplicated coordinate conversion code
- Consistent viewport handling across all shaders
- Cleaner, more focused shader code

## Shaders To Migrate

The following shaders still use the old pattern and should be migrated:

### 🔄 AnalyticalWaterStateShader
**Location:** `src/game/world-data/water/webgpu/AnalyticalWaterStateShader.ts`

**Current:** Uses `SIMPLEX_NOISE_3D_WGSL` string constant, ~550 lines of WGSL

**Opportunities:**
- Replace `SIMPLEX_NOISE_3D_WGSL` with `simplexNoise3DModule`
- Extract Gerstner wave calculation to module (reusable)
- Use `shoalingModule` and `shallowDampingModule` from wave-physics
- Use `viewportModule` for coordinate conversions
- Extract water modifier calculations (wake, ripple, current, obstacle) to modules

**Complexity:** HIGH - Complex wave physics with many data structures

### 🔄 TerrainStateShader
**Location:** `src/game/world-data/terrain/webgpu/TerrainStateShader.ts`

**Current:** Inline terrain computation, ~280 lines of WGSL

**Opportunities:**
- Use `catmullRomModule`, `distanceModule`, `idwModule`, `terrainStructuresModule`
- Extract contour rendering logic to modules
- Terrain modules already exist - just need to wire up the shader

**Complexity:** MEDIUM - Render shader (vertex + fragment), more complex than compute

### 🔄 SurfaceShader
**Location:** `src/game/surface-rendering/SurfaceShader.ts`

**Current:** Inline lighting and rendering, ~270 lines of WGSL

**Opportunities:**
- Use `waterLightingModule` for water rendering
- Use `hashModule` for `hash21` function
- Use `mathConstantsModule` for `PI` constant
- Extract sand rendering to module
- Extract normal computation to module

**Complexity:** MEDIUM - Fullscreen render shader with complex lighting

### ✅ ShadowTextureShader
**Location:** `src/game/wave-physics/ShadowTextureShader.ts`

**Status:** Converted to FullscreenShader subclass

**Current implementation:**
- Extends FullscreenShader with module composition
- Uses `fresnelDiffractionModule` for wave diffraction calculations
- Exposes `getShaderCode()` for use by ShadowTextureRenderer (which needs custom vertex buffer layout)

**Complexity:** LOW - Simple vertex + fragment, already exported as strings

## Old Pattern (Deprecated)

The following string constant exports are deprecated and should be replaced:

### ❌ `SIMPLEX_NOISE_3D_WGSL`
**Location:** `src/core/graphics/webgpu/WGSLSnippets.ts`

**Replacement:** `simplexNoise3DModule` from `noise.wgsl.ts`

**Status:** Still used by:
- ❌ AnalyticalWaterStateShader (to be migrated)

### ❌ `TERRAIN_CONSTANTS_WGSL`
**Location:** `src/game/world-data/terrain/TerrainConstants.ts`

**Replacement:** Inline constants or constants module

**Status:** Used by TerrainStateShader

### ❌ `SHADOW_TEXTURE_*_SHADER`
**Location:** `src/game/wave-physics/ShadowTextureShader.ts`

**Replacement:** Convert to FullscreenShader subclass with modules

**Status:** Still exported as strings

## Migration Guide

To convert a shader to use modules:

### For ComputeShader:

```typescript
// Before
class MyShader extends ComputeShader<typeof bindings> {
  readonly code = /*wgsl*/`
    ${SIMPLEX_NOISE_3D_WGSL}

    fn myFunction() { ... }

    @compute @workgroup_size(8, 8)
    fn main() { ... }
  `;
}

// After
class MyShader extends ComputeShader<typeof bindings> {
  protected modules = [simplexNoise3DModule, otherModule];

  protected mainCode = /*wgsl*/`
    fn myFunction() { ... }

    @compute @workgroup_size(8, 8)
    fn main() {
      let noise = simplex3D(pos); // From module!
      ...
    }
  `;
}
```

### For FullscreenShader:

```typescript
// Before
class MyShader extends FullscreenShader<typeof bindings> {
  readonly vertexCode = /*wgsl*/`...`;
  readonly fragmentCode = /*wgsl*/`...`;
}

// After
class MyShader extends FullscreenShader<typeof bindings> {
  protected vertexModules = [moduleA];
  protected fragmentModules = [moduleB, moduleC];

  protected vertexMainCode = /*wgsl*/`...`;
  protected fragmentMainCode = /*wgsl*/`...`;
}
```

## Benefits of Module System

1. **Code Reuse** - Write functions once, use everywhere
2. **Dependency Resolution** - Modules automatically include dependencies
3. **Type Safety** - TypeScript imports ensure correct module usage
4. **Maintainability** - Single source of truth for each function
5. **Testing** - Modules can be tested independently
6. **Documentation** - Each module is self-documenting
7. **Performance** - Automatic deduplication prevents code bloat

## Naming Conventions

Since WGSL doesn't have true namespacing, all exported functions use descriptive, specific names to avoid conflicts:

### General Guidelines

1. **Be Specific**: Prefer `uvInBounds` over `inBounds`, `pointLeftOfSegment` over `isLeft`
2. **Use Prefixes**: Action verbs like `compute`, `calculate`, `render` make purpose clear
3. **Context Matters**: Include domain context - `calculateWindVelocity`, not `calculateVelocity`
4. **Helper Functions**: Prefix with parent function - `simplex3D_permute` for helpers used by `simplex3D`

### Examples by Module

**Coordinates:**
- ✅ `uvToWorld`, `worldToUV` - Clear transformation direction
- ✅ `uvInBounds` - Specifies UV coordinate space

**Terrain:**
- ✅ `pointToLineSegmentDistance` - Fully qualified, not just `distance`
- ✅ `pointLeftOfSegment` - Specifies geometric relationship
- ✅ `catmullRomPoint` - Algorithm name included

**Lighting:**
- ✅ `computeFresnel`, `computeSpecular` - Action verb prefix
- ✅ `renderWaterLighting` - Domain-specific (water) + action

**Wave Physics:**
- ✅ `computeShoalingFactor` - Physics term + factor type
- ✅ `computeWaveFrequency` - Domain (wave) + property

**Noise:**
- ✅ `simplex3D` - Algorithm + dimensionality
- ✅ `simplex3D_permute` - Helper function prefix

### Anti-Patterns to Avoid

- ❌ `inBounds()` - Too generic
- ❌ `isLeft()` - Ambiguous context
- ❌ `distance()` - What kind of distance?
- ❌ `compute()` - Compute what?
- ❌ `mod289()` - Could conflict with other algorithms

## Design Patterns

### Module Composition

Modules can depend on other modules:

```typescript
export const complexModule: ShaderModule = {
  code: /*wgsl*/`
    fn complexFunction() {
      let noise = simplex3D(...); // From dependency
      let worldPos = uvToWorld(...); // From dependency
      ...
    }
  `,
  dependencies: [simplexNoise3DModule, viewportModule]
};
```

### Parameter Passing

Modules don't access uniforms directly - functions take parameters:

```typescript
// Good: Module function takes parameters
fn calculateWind(worldPos: vec2<f32>, time: f32, baseWind: vec2<f32>, ...) -> vec2<f32>

// Bad: Module function accesses uniform
fn calculateWind() {
  let worldPos = params.worldPos; // Don't do this!
}
```

This makes modules reusable across different shader contexts.

### Binding Independence

Modules should avoid declaring bindings when possible. If bindings are needed, document them clearly:

```typescript
// Binding-independent (preferred)
export const mathModule: ShaderModule = {
  code: /*wgsl*/`fn add(a: f32, b: f32) -> f32 { return a + b; }`,
};

// Requires bindings (document clearly)
export const terrainModule: ShaderModule = {
  code: /*wgsl*/`...`,
  bindings: {
    terrainData: { type: 'storage' }  // Required!
  }
};
```

## Testing

Test shaders using the module system are located in:
- `src/game/world/shaders/test-module-system.ts` - Demonstrates composition and dependency resolution

## Future Work

1. Complete migration of remaining shaders
2. Extract more shared utilities:
   - Normal computation from height fields
   - Texture sampling utilities
   - Common data structures
3. Remove deprecated string constants once all shaders are migrated
4. Consider extracting constants to their own modules
5. Add validation/testing for module composition
