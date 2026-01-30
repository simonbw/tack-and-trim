# GPU Hang Fix - Terrain Query System

## Summary

Fixed a critical GPU hang that occurred after the boat moved for several seconds. The issue was in the terrain query compute shader, specifically in the `pointInContour` function which was performing excessive iterations for complex contours.

## Root Cause

The `pointInContour` function in `TerrainTileCompute.ts` uses ray-casting to test if a point is inside a contour. It samples the contour at `contourCount * SAMPLES_PER_SEGMENT` points, where `SAMPLES_PER_SEGMENT = 32`.

For contours with many control points (e.g., 100), this resulted in:
- **3,200 iterations per containment check**

This function is called for every contour in the terrain hierarchy (root, children, grandchildren) for each query point. The worst-case scenario:

```
Per query point:
  Root contour (100 control points):     3,200 iterations
  5 children (50 control points each):   5 × 1,600 = 8,000 iterations
  5 grandchildren (20 control points):   5 × 640 = 3,200 iterations
  ──────────────────────────────────────────────────────────────
  Total:                                 ~14,400 iterations

With 64 query points per workgroup:     ~921,600 iterations/workgroup
```

This excessive computation caused GPU driver timeouts and browser freezes after accumulated shader dispatches.

## Solution

Added iteration limits to prevent runaway loops while maintaining accuracy for reasonable terrain complexity:

### 1. pointInContour Sample Limit
```wgsl
// TerrainTileCompute.ts line ~107
let safeSamples = min(numSamples, 5000u);
```
**Limit:** 5,000 samples (supports ~156 control points)

### 2. Tree Traversal Limits
```wgsl
// Root contours
let maxRootIterations = min(rootCount, 50u);

// Child contours
let maxChildIterations = min(childEnd - childStart, 50u);

// Grandchild contours
let maxGrandIterations = min(grandEnd - grandStart, 50u);
```
**Limit:** 50 iterations per level

### 3. Bounds Checking
Added array bounds checks before accessing `contours` array:
```wgsl
if (i >= arrayLength(&contours)) {
  break;
}
```

## Impact

- **Before:** GPU hang after ~5-10 seconds of boat movement
- **After:** Stable operation indefinitely

The limits are conservative enough to prevent GPU hangs while still supporting complex terrains with hundreds of control points across multiple hierarchy levels.

## Related Files

- `src/game/world/terrain/TerrainTileCompute.ts` - Fixed shader code
- `src/game/world/terrain/TerrainSystem.ts` - Added pointCount validation
- `src/game/world/water/WaterSystem.ts` - Added similar validation (preventative)

## Testing

Tested by:
1. Disabling terrain compute entirely → freeze stopped (confirmed culprit)
2. Re-enabling with aggressive limits (10) → no freeze but inaccurate results
3. Increasing to balanced limits (50/5000) → stable and accurate

## Notes

The issue was **not** caused by:
- Water system or water queries
- Wake/spray particles
- Bind group accumulation
- Buffer operations or memory leaks

It was purely a compute shader iteration problem that manifested after accumulated dispatches stressed the GPU scheduler.
