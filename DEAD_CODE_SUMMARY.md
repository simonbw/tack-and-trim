# Dead Code Analysis - Quick Summary

## Total Dead Code Found
**41 unused exports** in `src/game/` directory

## Top Candidates for Removal

### 🔴 High Priority (Safe to Remove)
1. **`DEFAULT_BOAT_CONFIG`** in `boat/BoatConfig.ts` - Already marked as `@deprecated`
2. **`test-module-system.ts`** - Entire test/development shader file
3. **`Buoy.ts`** - Complete but unused entity class (78 lines)

### 🟡 Medium Priority (Review First)
- **3 unused fluid dynamics functions** - `applyFluidForcesToBody`, `flatPlateLift`
- **1 boat config function** - `createBoatConfig` (not needed with single boat type)
- **6 water constants** - Marked as "not currently used" in comments
- **2 CPU terrain functions** - If GPU-only implementation is confirmed

### 🟢 Low Priority (Needs Investigation)
- **18 shader function exports** - May be dynamically loaded via module system
- **4 surface rendering items** - May be replaced by newer implementations
- **Various type definitions** - Low cost to keep

## Quick Stats by Category

| Category | Count | Notes |
|----------|-------|-------|
| Complete Entity Classes | 1 | Buoy (fully implemented but never used) |
| Fluid Dynamics Functions | 3 | May be for future features |
| Boat Configuration | 3 | Including 1 deprecated constant |
| Shader Functions (WGSL) | 18 | Need careful review - may be dynamic |
| Constants (Water/Wind/Terrain) | 9 | Some marked as unused in comments |
| Type Definitions | 4 | Low maintenance cost |
| Utility Functions | 3 | Type guards, validators, etc. |

## Estimated Code Reduction

If all high and medium priority items removed:
- **~150-200 lines** of actual game code
- **1 complete file** (Buoy.ts - 78 lines)
- **1 complete test file** (test-module-system.ts)

## Next Steps

See `DEAD_CODE_REPORT.md` for detailed analysis of each item, including:
- Exact file locations and line numbers
- Explanations of why each item is unused
- Specific recommendations for each case
- Important caveats about shader functions and constants

## Important Notes

⚠️ **Before removing shader-related code:**
- Check for string references (shader code may use function names as strings)
- Verify dynamic module composition isn't loading them

⚠️ **Before removing constants:**
- Check if they're interpolated into shader template strings
- Consider if they're planned for future features
