# Wave Shadow Algorithm Improvement Proposal

**Status**: ✅ COMPLETED

## Summary

Replace the tangent-based silhouette detection algorithm with an edge-normal classification approach. Fixes critical bug where axis-aligned waves produced no shadows.

## Current System (main branch)

**Algorithm**: Tangent zero-crossing detection
- Solves quadratic equation: where does coastline tangent become parallel to wave direction?
- Classifies points by curvature to determine shadow-casting vs shadow-ending
- Samples 32 points along "leeward" arc between extremal points
- **CRITICAL BUG**: Fails for axis-aligned waves (N/S or E/W directions)

**Implementation**: `src/game/wave-physics/SilhouetteComputation.ts` (248 lines)
- Analytical tangent calculation (quadratic function)
- Quadratic root finding with edge cases
- Complex curvature analysis
- Prone to infinite loops in arc sampling

## Proposed System (from analytical-water-shader-rewrite)

**Algorithm**: Edge-normal classification
- Sample spline densely (256 points)
- For each edge: compute outward normal, test `dot(normal, waveDir) < 0`
- Edges facing away from waves are shadow edges
- Transitions between lit/shadow edges mark silhouette vertices
- Extend shadow vertices far in wave direction to create shadow polygons

**Implementation**: `src/game/world/water/ShadowWorker.ts` (274 lines)
- Runs in Web Worker (~1ms per coastline, non-blocking)
- Simple geometric tests (no calculus)
- Supports multiple shadow regions per coastline
- Robust iteration limits prevent infinite loops

## Key Benefits

1. **Fixes Critical Bug** - Works for ALL wave directions (commit message: "Both wave directions now generate shadows")
2. **Robustness** - No quadratic solving, no numerical edge cases
3. **Simplicity** - Straightforward geometric test vs. complex mathematical analysis
4. **Better Geometry** - 256+ samples vs. 32, smoother shadow boundaries
5. **Non-Blocking** - Web Worker prevents frame drops during computation
6. **Multiple Shadows** - Handles concave coastlines naturally

## Algorithm Comparison

### Old: Tangent Zero-Crossing
```typescript
// Solve: cross(tangent, waveDir) = 0
// Tangent = 0.5 × (A + B×t + C×t²)
// Becomes: a×t² + b×t + c = 0
const roots = solveQuadratic(a, b, c);
// PROBLEM: Fails for certain wave directions
```

### New: Edge-Normal Classification
```typescript
// For each edge:
const normal = { x: edge.y, y: -edge.x }; // 90° rotation
const isShadowEdge = dot(normal, waveDir) < 0;
// Simple, robust, always works
```

## Migration Path

### Phase 1: Add Web Worker Infrastructure
- Copy `src/game/world/water/ShadowWorker.ts`
- Set up worker pool for parallel processing
- Add `shadowsComputed` custom event

### Phase 2: Update WaveShadow System
- Replace `SilhouetteComputation` calls with worker dispatch
- Handle async shadow polygon updates
- Maintain existing `WaveShadow` entity interface

### Phase 3: Remove Old System
- Delete `src/game/wave-physics/SilhouetteComputation.ts`
- Delete `src/game/wave-physics/ShadowGeometry.ts`
- Clean up unused imports

### Phase 4: Testing
- Verify shadows appear for all wave directions
- Test concave coastlines with multiple shadow regions
- Profile worker performance

## Example Usage

```typescript
class WaveShadow {
  private worker: Worker;

  updateShadows(coastlines: Coastline[]) {
    // Dispatch to worker
    this.worker.postMessage({
      coastlines: coastlines.map(c => c.points),
      waveDirection: this.waveDirection,
    });
  }

  @on("shadowsComputed")
  onShadowsComputed(polygons: ShadowPolygon[]) {
    // Update VirtualTexture with new shadow geometry
    this.shadowPolygons = polygons;
    this.virtualTexture.invalidateAll();
  }
}
```

## Performance Impact

- **Computation time**: ~1ms per coastline (measured in worker)
- **Main thread impact**: Zero (runs in background)
- **Memory**: Similar to old system (polygon vertices)
- **Quality**: Significantly better (256 samples vs 32)

## Potential Issues

1. **Worker overhead** - Creating/managing workers adds complexity
   - **Mitigation**: Worker pool can be reused across shadow systems

2. **Async updates** - Shadow computation is no longer synchronous
   - **Mitigation**: Already designed for async (VirtualTexture handles gracefully)

## Recommendation

**STRONGLY RECOMMEND** adopting this change. The bug fix alone justifies the migration (axis-aligned waves are common in sailing scenarios). The simplification and robustness improvements are significant bonuses.

This is a clear win with minimal downside.

## File References

**New System:**
- `src/game/world/water/ShadowWorker.ts`

**To Remove:**
- `src/game/wave-physics/SilhouetteComputation.ts`
- `src/game/wave-physics/ShadowGeometry.ts`

**To Update:**
- `src/game/world/water/WaveShadow.ts`
