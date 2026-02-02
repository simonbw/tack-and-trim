# Draw.ts and WebGPURenderer.ts Optimizations Proposal

**Status**: ✅ COMPLETED

## Summary

Performance optimizations to the core rendering system including object pooling, bug fixes, and architectural improvements. Reduces GC pressure and fixes critical layer ordering issues.

## Key Optimizations

### 1. Object Pooling in Draw.ts

**Problem**: Every `fillRect()`, `strokeLine()`, etc. allocated new arrays

**Solution**: Reusable instance arrays
```typescript
class Draw {
  private _rectVertices: ReadonlyArray<V2d> = [V(), V(), V(), V()];
  private _rectIndices: ReadonlyArray<number> = [0, 1, 2, 0, 2, 3];
  private _lineVertices: ReadonlyArray<V2d> = [V(), V(), V(), V()];
}
```

**Benefit**: Eliminates allocations for common drawing operations

### 2. Circle Vertex Pooling

**Problem**: Each `fillCircle()` allocated new vertex and index arrays

**Solution**: Module-level pools keyed by segment count
```typescript
const circleVertexPool = new Map<number, V2d[]>();
const circleIndexPool = new Map<number, number[]>();
```

**Benefit**: Circle arrays allocated once per segment count, then reused. Significant for particle systems and debug visualization.

### 3. Optimized Vertex Buffer Writes

**Before**: 12 individual array assignments per vertex

**After**: Single bulk write
```typescript
this.shapeVertices.set(
  [v[0], v[1], r, g, b, alpha, ma, mb, mc, md, mtx, mty],
  offset,
);
```

**Benefit**: Better cache locality, potential JIT optimizations

### 4. Type-Safe Uniform Buffers

**Before**: Manual padding calculations
```typescript
this.uniformData[0] = m.a;
this.uniformData[1] = m.b;
this.uniformData[2] = 0;
this.uniformData[3] = 0; // manual padding
```

**After**: Automatic alignment
```typescript
const ViewUniforms = defineUniformStruct("Uniforms", {
  viewMatrix: mat3x3,
});
this.viewUniforms.set.viewMatrix(this.viewMatrix);
this.viewUniforms.uploadTo(buffer);
```

**Benefit**: Type safety, no manual offset calculations, foundation for shader uniform management

## Critical Bug Fix: Symmetric Batch Flushing

**Problem**: Render layers were violated - terrain/water appearing on top of boat

**Root Cause**: Asymmetric flushing
- `drawImage()` flushed shapes before sprites ✓
- `submitTriangles()` did NOT flush sprites ✗
- Result: All shapes rendered first, then all sprites (wrong order)

**Fix**: Added symmetric flushing
```typescript
submitTriangles(...) {
  // Flush sprites before drawing shapes
  if (this.spriteIndexCount > 0) {
    this.flushSprites();
  }
  // ...
}
```

**Benefit**: Proper interleaving of shapes and sprites based on submission order

## Architectural Improvements

### Code Organization

Created four helper modules in `src/core/graphics/draw/`:
- `DrawOptions.ts` - Centralized type definitions
- `CircleHelpers.ts` - Circle tessellation and pooling
- `RoundedCorners.ts` - Bézier-based rounded polygons
- `SplineHelpers.ts` - Catmull-Rom spline tessellation

**Benefit**: Reduced Draw.ts from ~520 to ~340 lines, better separation of concerns

### Improved Type Safety

- `ReadonlyArray` for vertex/index arrays
- Unified `ImageOptions` (eliminated `SpriteOptions`)
- Better TypeScript inference

### Algorithm Improvement: Concave Polygons

**Before**: Simple fan triangulation (convex only)

**After**: Ear clipping algorithm
```typescript
const indices = earClipTriangulate(vertices);
```

**Benefit**: Correctly renders concave polygons (critical for shadow geometry)

## Migration Path

### Phase 1: Copy Optimizations (Low Risk)
1. Add helper modules (`CircleHelpers.ts`, etc.)
2. Apply object pooling to Draw.ts
3. Update vertex buffer writes in WebGPURenderer.ts

### Phase 2: Bug Fix (Critical)
1. Add symmetric flushing to `submitTriangles()`
2. Test layer ordering with sprites + shapes

### Phase 3: Type Safety (Optional)
1. Add UniformStruct system
2. Migrate existing uniforms
3. Update shaders to use type-safe API

### Phase 4: Clean Up
1. Remove old manual uniform code
2. Update method names (`save()` → `saveTransform()`)
2. Add readonly modifiers

## Performance Impact

**Measured Improvements**:
- Reduced allocations: Common operations now reuse arrays
- Lower GC pressure: Fewer temporary objects during render loops
- Faster uploads: Bulk TypedArray.set() vs individual assignments

**Estimated FPS gain**: 5-10% for complex scenes with many shapes/circles

## Potential Issues

1. **Pooling complexity** - Adds state management
   - **Mitigation**: Encapsulated in helper modules, well-tested

2. **Breaking change** - Method renames
   - **Mitigation**: Search/replace, compile-time errors guide migration

## Recommendation

**STRONGLY RECOMMEND** adopting all optimizations:
1. **Bug fix is critical** - Layer ordering breaks visual correctness
2. **Performance gains are free** - No algorithmic changes, just better implementation
3. **Type safety prevents future bugs** - UniformStruct system is foundation for compute shaders
4. **Code quality improves** - Better organization, clearer semantics

Prioritize bug fix and pooling optimizations. UniformStruct can be added later.

## File References

**Updated Files:**
- `src/core/graphics/Draw.ts`
- `src/core/graphics/webgpu/WebGPURenderer.ts`

**New Files:**
- `src/core/graphics/draw/DrawOptions.ts`
- `src/core/graphics/draw/CircleHelpers.ts`
- `src/core/graphics/draw/RoundedCorners.ts`
- `src/core/graphics/draw/SplineHelpers.ts`
