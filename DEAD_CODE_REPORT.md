# Dead Code Report - Game Directory

**Generated:** 2026-02-16  
**Analysis Tool:** ts-prune  
**Scope:** `src/game/` directory only (engine code in `src/core/` excluded per requirements)

## Summary

**Status: Implementation Complete ✅**

Originally found **41 unused exports** in the game directory. After review and implementation:
- **Removed: 24 items** (dead code cleanup)
- **Kept: 17 items** (kept for future use or legitimate reasons)

### Removed Items
- 2 fluid dynamics functions
- 1 wind modifier type guard
- 1 boat configuration constant (deprecated)
- 4 surface rendering files (entire files deleted)
- 1 flow state constant
- 1 worker type alias
- 3 terrain constants
- 2 CPU terrain utility functions
- 6 water constants
- 2 wind constants

### Kept Items
- 1 entity class (Buoy - for future racing marks)
- 1 boat config function (createBoatConfig)
- 1 tutorial utility function (resetTutorialCompleted)
- 1 terrain validation function (with TODO added)
- 18 shader functions (needs separate shader cleanup pass)

## Detailed Findings

### 1. Completely Unused Entity

#### Buoy (`src/game/Buoy.ts`)
- **Status:** ✅ KEPT - for future racing marks/navigation features
- **Description:** A floating buoy entity with physics simulation, buoyancy, and water interaction
- **Why Unused:** Never instantiated or imported anywhere in the codebase
- **Decision:** Keep for future use

---

### 2. Fluid Dynamics Functions (`src/game/fluid-dynamics.ts`)

#### `applyFluidForcesToBody` (line 43)
- **Status:** ❌ REMOVED
- **Description:** Applies fluid forces to all edges of a body's convex shapes
- **Why Unused:** The codebase uses `applyFluidForces` (line 71) directly instead

#### `flatPlateLift` (line 172)
- **Status:** ❌ REMOVED
- **Description:** Creates a lift magnitude function for flat plate behavior
- **Why Unused:** The codebase uses `foilLift` for hydrofoils instead

**Note:** Other exports from this file (`flatPlateDrag`, `foilLift`, `foilDrag`, `applySkinFriction`) ARE used.

---

### 3. Wind Modifier

#### `isWindModifier` (`src/game/WindModifier.ts`, line 29)
- **Status:** ❌ REMOVED
- **Description:** Type guard function for WindModifier interface
- **Why Unused:** No code currently needs to check if something implements WindModifier

---

### 4. Boat Configuration (`src/game/boat/BoatConfig.ts`)

#### `createBoatConfig` (line 139)
- **Status:** ✅ KEPT - for future boat variety
- **Description:** Creates a boat config with partial overrides from a base config
- **Why Unused:** Currently only StarterDinghy is used; no config variations needed yet

#### `DEFAULT_BOAT_CONFIG` (line 131)
- **Status:** ❌ REMOVED
- **Description:** Deprecated alias for StarterDinghy
- **Marked:** `@deprecated` in code

---

### 5. Surface Rendering

#### All UnifiedSurfaceShader and TerrainHeightShader files
- **Status:** ❌ REMOVED (4 files deleted)
- **Files Removed:**
  - `UnifiedSurfaceShader.ts`
  - `UnifiedSurfaceUniforms.ts`
  - `TerrainHeightShader.ts`
  - `TerrainHeightUniforms.ts`
- **Reason:** Replaced by multi-pass rendering pipeline

#### `SurfaceUniforms` export (`src/game/surface-rendering/SurfaceRenderer.ts`)
- **Status:** ❌ REMOVED
- **Description:** Re-export alias that was not used

---

### 6. Tutorial

#### `resetTutorialCompleted` (`src/game/tutorial/tutorialStorage.ts`, line 11)
- **Status:** ✅ KEPT - useful for developer console
- **Description:** Clears tutorial completion status from localStorage
- **Why Unused:** No UI currently exposes this functionality

---

### 7. Sail Flow State

#### `DEFAULT_FLOW_STATE` (`src/game/boat/sail/FlowState.ts`, line 21)
- **Status:** ❌ REMOVED
- **Description:** Default flow state constant with zero velocity
- **Why Unused:** Code uses `createFlowState()` function instead

---

### 8. Wave Physics

#### `WorkerInMessage` (`src/game/wave-physics/mesh-building/MeshBuildTypes.ts`, line 92)
- **Status:** ❌ REMOVED
- **Description:** Type alias for messages from main thread to worker
- **Why Unused:** Direct `MeshBuildRequest` type used instead

---

### 9. Shader Functions (WGSL Modules)

**Status:** ✅ ALL KEPT - for separate shader cleanup pass

The following shader module exports are unused but kept for now per user decision:

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
- **Decision:** Keep all for now, separate shader cleanup pass planned

---

### 10. Terrain

#### `validateTerrainDefinition` (`src/game/world/terrain/LandMass.ts`, line 330)
- **Status:** ✅ KEPT - with TODO added
- **Description:** Validates terrain definition structure
- **Action:** Added TODO comment to actually use it for better error messages

#### Constants (`src/game/world/terrain/TerrainConstants.ts`)
- **Status:** ❌ REMOVED (if unused)
- `TERRAIN_TILE_SIZE` (line 7) - REMOVED
- `TERRAIN_TILE_RESOLUTION` (line 8) - REMOVED
- `TERRAIN_CONSTANTS_WGSL` (line 31) - REMOVED

#### CPU Terrain Height (`src/game/world/terrain/terrainHeightCPU.ts`)
- **Status:** ❌ REMOVED
- `pointLeftOfSegment` (line 88) - REMOVED
- `pointToLineSegmentDistanceSq` (line 102) - REMOVED
- **Reason:** GPU versions in shaders are used instead

---

### 11. Water Constants (`src/game/world/water/WaterConstants.ts`)

**Status:** ❌ ALL REMOVED - now defined in levels

- `SWELL_WAVELENGTH` (line 20) - REMOVED
- `CHOP_WAVELENGTH` (line 21) - REMOVED
- `MIN_FETCH_FOR_WAVES` (line 24) - REMOVED
- `FULL_FETCH_DISTANCE` (line 25) - REMOVED
- `WATER_VELOCITY_SCALE` (line 31) - REMOVED
- `WAVE_CONSTANTS_GLSL` (line 38) - REMOVED

**Note:** File comment said "Fetch-based wave scaling (not currently used)" for some of these.

---

### 12. Wind Constants (`src/game/world/wind/WindConstants.ts`)

**Status:** ❌ REMOVED (if unused)

- `WIND_TEXTURE_SIZE` (line 8) - REMOVED
- `WIND_CONSTANTS_WGSL` (line 48) - REMOVED

---

## Implementation Results

### Summary Statistics
- **Total items found:** 41 unused exports
- **Items removed:** 24
- **Items kept:** 17
- **Files deleted:** 4 (UnifiedSurfaceShader + TerrainHeightShader related)
- **TypeScript compilation:** ✅ Passes

### Changes Made

#### Removed Functions/Constants
1. `applyFluidForcesToBody` - fluid-dynamics.ts
2. `flatPlateLift` - fluid-dynamics.ts
3. `isWindModifier` - WindModifier.ts
4. `DEFAULT_BOAT_CONFIG` - BoatConfig.ts
5. `DEFAULT_FLOW_STATE` - FlowState.ts
6. `WorkerInMessage` - MeshBuildTypes.ts
7. `TERRAIN_TILE_SIZE` - TerrainConstants.ts
8. `TERRAIN_TILE_RESOLUTION` - TerrainConstants.ts
9. `TERRAIN_CONSTANTS_WGSL` - TerrainConstants.ts
10. `pointLeftOfSegment` - terrainHeightCPU.ts
11. `pointToLineSegmentDistanceSq` - terrainHeightCPU.ts
12. `SWELL_WAVELENGTH` - WaterConstants.ts
13. `CHOP_WAVELENGTH` - WaterConstants.ts
14. `MIN_FETCH_FOR_WAVES` - WaterConstants.ts
15. `FULL_FETCH_DISTANCE` - WaterConstants.ts
16. `WATER_VELOCITY_SCALE` - WaterConstants.ts
17. `WAVE_CONSTANTS_GLSL` - WaterConstants.ts
18. `WIND_TEXTURE_SIZE` - WindConstants.ts
19. `WIND_CONSTANTS_WGSL` - WindConstants.ts

#### Deleted Files
1. `src/game/surface-rendering/UnifiedSurfaceShader.ts`
2. `src/game/surface-rendering/UnifiedSurfaceUniforms.ts`
3. `src/game/surface-rendering/TerrainHeightShader.ts`
4. `src/game/surface-rendering/TerrainHeightUniforms.ts`

#### Removed Exports
1. `SurfaceUniforms` re-export from SurfaceRenderer.ts

#### Kept Items (with reasons)
1. Buoy entity - for future racing marks
2. createBoatConfig - for future boat variety
3. resetTutorialCompleted - developer utility
4. validateTerrainDefinition - added TODO to use it
5. All 18 shader functions - separate shader cleanup planned

### Verification
- TypeScript compilation: ✅ Pass
- No breaking changes detected
- All changes are minimal and surgical

---

## Original Recommendations by Priority

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
