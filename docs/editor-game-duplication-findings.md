# Editor/Game Code Duplication Findings

Analysis of code duplication between `src/editor/` and `src/game/` modules.

---

## 1. Catmull-Rom Spline Evaluation

**Severity: HIGH** - Exact copy-paste duplication

**Location A:** `src/editor/ContourRenderer.ts` lines 82-101
**Location B:** `src/game/world-data/terrain/SplineGeometry.ts` lines 37-56

The SplineGeometry.ts file explicitly acknowledges this with a comment:
```typescript
/**
 * Evaluate a Catmull-Rom spline point.
 * Copied from ContourRenderer.ts to avoid cross-module dependency.
 */
```

Both files contain identical ~20-line `catmullRomPoint()` function implementing the same Catmull-Rom cubic interpolation formula.

---

## 2. Spline Sampling to Polygon

**Severity: HIGH** - Nearly identical logic

**Location A:** `src/editor/ContourRenderer.ts` lines 261-281 - `sampleSplinePolygon()`
**Location B:** `src/game/world-data/terrain/SplineGeometry.ts` lines 76-102 - `sampleClosedSpline()`

Both functions:
- Iterate through control points of a closed spline
- Sample each segment at regular intervals
- Use the same wrapping index calculation `(i - 1 + n) % n`
- Build up an array of sampled points

The main difference is SplineGeometry has a `samplesPerSegment` parameter with default 16, while ContourRenderer uses a hardcoded 8.

---

## 3. Point-in-Polygon Ray Casting

**Severity: MEDIUM** - Identical algorithm

**Location A:** `src/editor/ContourRenderer.ts` lines 286-305 - `pointInPolygon()`
**Location B:** `src/game/world-data/terrain/SplineGeometry.ts` lines 315-334 - inside `isPointInsideSpline()`

Both implement the classic ray-casting algorithm with identical logic:
```typescript
for (let i = 0, j = n - 1; i < n; j = i++) {
  const xi = polygon[i].x, yi = polygon[i].y;
  const xj = polygon[j].x, yj = polygon[j].y;
  if (yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) {
    inside = !inside;
  }
}
```

---

## 4. Surface Renderer

**Severity: HIGH** - ~70% structural duplication

**Location A:** `src/game/surface-rendering/SurfaceRenderer.ts` (525 lines)
**Location B:** `src/editor/EditorSurfaceRenderer.ts` (394 lines)

### Identical Methods/Logic:
| Method | Description |
|--------|-------------|
| `ensureInitialized()` | GPU buffer/sampler/texture creation |
| `getExpandedViewport()` | Viewport margin calculation |
| `setCameraMatrix()` | Mat3x3 packing with 16-byte alignment |
| `setTime()` | Uniform index 12 |
| `setRenderMode()` | Uniform index 13 |
| `setScreenSize()` | Uniform indices 14-15 |
| `setViewportBounds()` | Uniform indices 16-19 |
| `setHasTerrainData()` | Uniform index 21 |
| `setWetnessViewportBounds()` | Uniform indices 24-27 |
| `renderSurface()` | Bind group creation and shader invocation |
| Placeholder texture creation | 1x1 terrain and wetness textures |
| Uniform buffer layout | Float32Array[28] with documented indices |

### Differences:
| Feature | SurfaceRenderer | EditorSurfaceRenderer |
|---------|-----------------|----------------------|
| Texture size | 512 | 256 |
| Wetness pipeline | Full implementation | Placeholder only |
| GPU profiler | Passed to pipelines | null |
| Render mode | Keyboard toggle (B key) | From EditorController |
| Influence config | Polling InfluenceFieldManager | Event-driven via `influenceFieldsReady` |

---

## 5. Terrain Height Color Calculation

**Severity: LOW-MEDIUM** - Similar gradient logic, different values

**Location A:** `src/editor/ContourRenderer.ts` lines 58-77 - `getContourColor()`
**Location B:** `src/game/surface-rendering/SurfaceRenderer.ts` lines 473-491 - inline in debug draw

Both calculate colors based on terrain height:
- Height = 0: Green (shore)
- Height < 0: Blue gradient (darker for deeper)
- Height > 0: Brown/tan gradient (lighter for higher)

The formulas are similar but have slightly different RGB values:

**Editor (ContourRenderer):**
```typescript
// Underwater
const t = Math.min(-height / 50, 1);
r = 50 * (1 - t);
g = 100 + 50 * (1 - t);
b = 180 + 75 * (1 - t);
```

**Game (SurfaceRenderer):**
```typescript
// Underwater
const t = Math.min(-contour.height / 50, 1);
r = 50 * (1 - t);
g = 100 * (1 - t * 0.5);  // Different formula
b = 200 + 55 * (1 - t);   // Different values
```

---

## Summary Table

| # | Duplication | Severity | Risk to Fix |
|---|-------------|----------|-------------|
| 1 | Catmull-Rom spline evaluation | HIGH | LOW |
| 2 | Spline sampling to polygon | HIGH | LOW |
| 3 | Point-in-polygon ray casting | MEDIUM | LOW |
| 4 | Surface renderer (~70% overlap) | HIGH | MEDIUM |
| 5 | Terrain height color | LOW-MEDIUM | LOW |
