# Dead Code Report - Game Directory

**Generated:** 2026-02-16  
**Analysis Tool:** ts-prune  
**Scope:** `src/game/` directory only (engine code in `src/core/` excluded per requirements)

## Summary

Found **41 unused exports** in the game directory across multiple categories:
- 1 completely unused entity class
- 3 unused fluid dynamics functions
- 3 unused boat configuration items
- 1 unused type guard function
- 4 unused surface rendering items
- 1 unused tutorial utility function
- 2 unused flow state items
- 1 unused worker type
- 18 unused shader functions/modules
- 3 unused terrain functions
- 6 unused water/wind constants

## Detailed Findings

### 1. Completely Unused Entity

#### Buoy (`src/game/Buoy.ts`)
- **Status:** ✅ Complete, working implementation
- **Description:** A floating buoy entity with physics simulation, buoyancy, and water interaction
- **Why Unused:** Never instantiated or imported anywhere in the codebase
- **Recommendation:** This appears to be fully implemented game content that was never used. Could be removed or kept for future racing marks/navigation features.

---

### 2. Fluid Dynamics Functions (`src/game/fluid-dynamics.ts`)

#### `applyFluidForcesToBody` (line 43)
- **Description:** Applies fluid forces to all edges of a body's convex shapes
- **Why Unused:** The codebase uses `applyFluidForces` (line 71) directly instead
- **Recommendation:** If this was meant to be a convenience function, it could be removed. Otherwise, consider using it where appropriate.

#### `flatPlateLift` (line 172)
- **Description:** Creates a lift magnitude function for flat plate behavior
- **Why Unused:** The codebase uses `foilLift` for hydrofoils instead
- **Recommendation:** Keep if intended for future hull modeling; remove if obsolete.

**Note:** Other exports from this file (`flatPlateDrag`, `foilLift`, `foilDrag`, `applySkinFriction`) ARE used.

---

### 3. Wind Modifier

#### `isWindModifier` (`src/game/WindModifier.ts`, line 29)
- **Description:** Type guard function for WindModifier interface
- **Why Unused:** No code currently needs to check if something implements WindModifier
- **Recommendation:** Keep as a defensive/utility function, or remove if truly not needed.

---

### 4. Boat Configuration (`src/game/boat/BoatConfig.ts`)

#### `createBoatConfig` (line 139)
- **Description:** Creates a boat config with partial overrides from a base config
- **Why Unused:** Currently only StarterDinghy is used; no config variations needed yet
- **Recommendation:** Keep for future boat variety, or remove if single config is sufficient.

#### `DEFAULT_BOAT_CONFIG` (line 131)
- **Status:** Marked as `@deprecated` in code
- **Description:** Alias for StarterDinghy
- **Recommendation:** **Remove** - already deprecated, StarterDinghy is used directly.

---

### 5. Surface Rendering

#### `SurfaceUniforms` (`src/game/surface-rendering/SurfaceRenderer.ts`, line 40)
- **Type:** TypeScript type definition
- **Why Unused:** Type is defined but never referenced
- **Recommendation:** Remove if not needed; keep if used for documentation/typing purposes.

#### `TerrainHeightUniforms` (`src/game/surface-rendering/TerrainHeightUniforms.ts`, line 14)
- **Type:** TypeScript type definition
- **Why Unused:** Defined using `defineUniformStruct` but the type itself isn't imported elsewhere
- **Recommendation:** May be used internally by the shader system; verify before removing.

#### `createTerrainHeightShader` (`src/game/surface-rendering/TerrainHeightShader.ts`, line 105)
- **Description:** Factory function for creating terrain height shader
- **Why Unused:** Shader may have been replaced by UnifiedSurfaceShader
- **Recommendation:** Check if entire file is obsolete; could be significant cleanup opportunity.

#### `createUnifiedSurfaceShader` (`src/game/surface-rendering/UnifiedSurfaceShader.ts`, line 348)
- **Description:** Factory function for creating unified surface shader
- **Why Unused:** Shader might be created differently now
- **Recommendation:** Verify actual shader usage pattern before removing.

---

### 6. Tutorial

#### `resetTutorialCompleted` (`src/game/tutorial/tutorialStorage.ts`, line 11)
- **Description:** Clears tutorial completion status from localStorage
- **Why Unused:** No UI currently exposes this functionality
- **Recommendation:** Keep for developer console use or future "reset tutorial" button.

---

### 7. Sail Flow State

#### `DEFAULT_FLOW_STATE` (`src/game/boat/sail/FlowState.ts`, line 21)
- **Description:** Default flow state constant with zero velocity
- **Why Unused:** Code uses `createFlowState()` function instead
- **Recommendation:** Remove if `createFlowState()` is always preferred.

---

### 8. Wave Physics

#### `WorkerInMessage` (`src/game/wave-physics/mesh-building/MeshBuildTypes.ts`, line 92)
- **Type:** Type alias for messages from main thread to worker
- **Why Unused:** Direct `MeshBuildRequest` type used instead
- **Recommendation:** Remove type alias or use it for better semantic clarity.

---

### 9. Shader Functions (WGSL Modules)

The following shader module exports are unused. These are typically function definitions or shader code snippets used in GPU shaders:

#### Normal Computation (`src/game/world/shaders/normal-computation.wgsl.ts`)
- `fn_computeNormalFromHeightField` (line 11)

#### Polygon Utilities (`src/game/world/shaders/polygon.wgsl.ts`)
- `fn_isInsidePolygon` (line 43)
- `fn_isInsidePolygonWithBBox` (line 92)
- `fn_distanceToPolygonBoundary` (line 166)

#### Terrain (`src/game/world/shaders/terrain.wgsl.ts`)
- `fn_computeIDWWeight` (line 39) - Inverse Distance Weighting
- `fn_blendIDW` (line 51) - IDW blending function

#### Test Shader (`src/game/world/shaders/test-module-system.ts`)
- `createTestModuleSystemShader` (line 80)
- **Recommendation:** **Remove** - This is clearly a test/development file.

#### Water (`src/game/world/shaders/water.wgsl.ts`)
- `fn_computeWaterAtPoint` (line 208)

#### Wave Physics (`src/game/world/shaders/wave-physics.wgsl.ts`)
- `fn_computeShoalingFactor` (line 18)
- `fn_computeShallowDamping` (line 48)
- `fn_computeWaveFrequency` (line 75)
- `fn_computeWaveNumber` (line 90)
- `fn_computeRefractionOffset` (line 146)

#### Wave-Terrain Interaction (`src/game/world/shaders/wave-terrain.wgsl.ts`)
- `fn_computeWaveTerrainFactor` (line 87)

**Shader Notes:**
- These exports use a shader module system where functions can be composed
- Many are likely remnants of earlier implementations or unused features
- Some might be used dynamically through the module system in ways ts-prune can't detect
- **Recommendation:** Carefully review each shader file to confirm these aren't dynamically loaded

---

### 10. Terrain

#### `validateTerrainDefinition` (`src/game/world/terrain/LandMass.ts`, line 330)
- **Description:** Validates terrain definition structure
- **Why Unused:** Validation might happen elsewhere or not at all
- **Recommendation:** Consider using for better error messages, or remove if not needed.

#### Constants (`src/game/world/terrain/TerrainConstants.ts`)
- `TERRAIN_TILE_SIZE` (line 7)
- `TERRAIN_TILE_RESOLUTION` (line 8)
- `TERRAIN_CONSTANTS_WGSL` (line 31)
- **Why Unused:** These might be legacy constants or used in shaders that ts-prune doesn't analyze
- **Recommendation:** Check if used in WGSL shader code strings before removing.

#### CPU Terrain Height (`src/game/world/terrain/terrainHeightCPU.ts`)
- `pointLeftOfSegment` (line 88)
- `pointToLineSegmentDistanceSq` (line 102)
- **Description:** CPU-side implementations of geometry functions
- **Why Unused:** GPU versions in shaders are used instead
- **Recommendation:** Keep if needed for testing/editor; remove if GPU-only is sufficient.

---

### 11. Water Constants (`src/game/world/water/WaterConstants.ts`)

- `SWELL_WAVELENGTH` (line 20) - 200 ft
- `CHOP_WAVELENGTH` (line 21) - 30 ft  
- `MIN_FETCH_FOR_WAVES` (line 24) - 100 ft
- `FULL_FETCH_DISTANCE` (line 25) - 5000 ft
- `WATER_VELOCITY_SCALE` (line 31) - 10.0
- `WAVE_CONSTANTS_GLSL` (line 38) - GLSL code snippet

**Note:** File comment says "Fetch-based wave scaling (not currently used)" for some of these.

**Recommendation:** Remove constants marked as "not currently used" unless planned for future features.

---

### 12. Wind Constants (`src/game/world/wind/WindConstants.ts`)

- `WIND_TEXTURE_SIZE` (line 8) - 256
- `WIND_CONSTANTS_WGSL` (line 48) - WGSL code snippet

**Note:** These might be used in shader code strings that ts-prune doesn't analyze.

**Recommendation:** Verify usage in shader template strings before removing.

---

## Recommendations by Priority

### High Priority (Safe to Remove)
1. **`DEFAULT_BOAT_CONFIG`** - Already deprecated
2. **`test-module-system.ts`** - Test/development file
3. **`Buoy.ts`** - Complete unused entity (unless planned for future use)

### Medium Priority (Review Before Removing)
4. **Unused fluid dynamics functions** - May be for future features
5. **Unused boat config function** - May be needed for boat variety
6. **Fetch-related water constants** - Marked as "not currently used"
7. **CPU terrain functions** - If GPU-only approach is confirmed

### Low Priority (Keep or Further Investigation)
8. **Shader module functions** - May be dynamically loaded
9. **Type definitions** - May be for documentation/typing
10. **`isWindModifier`** - Defensive type guard
11. **`resetTutorialCompleted`** - Useful for developers

## Notes

- **Shader Functions:** Many shader exports may be used via dynamic module composition that static analysis can't detect. Manual verification recommended.
- **Constants in Shaders:** Constants exported from TypeScript but used in template string shaders won't be detected by ts-prune.
- **Type Definitions:** TypeScript types that are defined but not explicitly imported may still provide value for IDE autocomplete and documentation.

## Action Items

Before removing any code:
1. Search for string references (e.g., shader code may reference functions by name as strings)
2. Check if code is planned for upcoming features
3. Verify that tests don't rely on these exports
4. Consider the maintenance cost of keeping vs. removing
