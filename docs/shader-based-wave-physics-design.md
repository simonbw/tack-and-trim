# Analytical Wave Physics Design

## Overview

This document describes a fully analytical approach to simulating wave-terrain interactions. The key insight is that our terrain is defined by Catmull-Rom spline contours, which allows us to compute all wave physics effects analytically without grid-based textures. This eliminates resolution artifacts and provides mathematically exact results at any zoom level.

### Goals

- Eliminate all grid-based artifacts by using analytical geometry
- Implement physics-based diffraction (Fresnel model for energy, Huygens for direction)
- Waves in bays/inlets appear to radiate from the inlet opening
- Add refraction (waves bend toward shallower water)
- Add shoaling (waves grow taller in shallow water)
- Proper shadow behavior (fills in over distance, handles lakes correctly)
- Enable reflection off steep shores

### Current System Problems

1. **Grid aliasing**: Fixed 50-100ft cells create visible rectangular boundaries
2. **Wrong diffraction model**: Lateral spread factor doesn't match Fresnel physics
3. **Infinite shadow**: Energy decays forever instead of diffraction filling shadow
4. **Lake problem**: Ray-casting can incorrectly show waves in landlocked water
5. **Memory waste**: 3D texture covers open ocean at same resolution as coastlines
6. **Missing effects**: No shoaling, no refraction, no reflection

### Why Analytical?

Our terrain is defined by Catmull-Rom spline contours. Every time we sample a grid texture, we lose precision and introduce artifacts. By computing directly from the spline geometry:

- Perfect resolution at any scale
- No quantization artifacts at coastlines
- Mathematically correct shadow boundaries
- Handles complex geometry (lakes, narrow channels) correctly

---

## Architecture

### Terrain Data Requirements

The system requires the following terrain constraints:

1. **Coastlines are height=0 contours**: Every land/water boundary must be defined by a contour with height exactly 0. The editor should enforce that any contour with positive height has a height=0 ancestor before any negative-height ancestor.

2. **Contours are Catmull-Rom splines**: Closed loops of control points defining terrain boundaries.

3. **Contour hierarchy**: Parent/child relationships define terrain nesting (islands, lakes, etc.)

### Pre-Computed Data (Per Wave Direction)

For each discrete wave direction (e.g., 16 directions at 22.5° intervals):

| Data | Type | Purpose |
|------|------|---------|
| Shadow geometry | Line segments | Shadow boundary lines extending from silhouette points |
| Silhouette points | Points + metadata | Coastline points where tangent ∥ wave direction |

This geometry is recomputed when:
- Terrain changes (editor updates)
- Wave direction changes significantly (interpolate between precomputed directions)

### Runtime Computation (Per-Pixel, Analytical)

| Computation | Method |
|-------------|--------|
| Water depth | Analytical: IDW interpolation over contours |
| Land/water test | Analytical: Winding number on coastline contours |
| Coastal SDF | Analytical: Distance to nearest coastline spline |
| Shadow test | Geometric: Point-in-shadow-polygon test |
| Diffraction energy | Analytical: Distance to shadow boundary + Fresnel formula |
| Diffraction direction | Analytical: Huygens principle (waves emanate from silhouette points) |
| Shoaling | Analytical: Green's law using analytical depth |
| Refraction | Analytical: Depth gradient via `dpdx`/`dpdy` |

**No grid textures are sampled for wave physics.**

---

## Shadow Geometry

### The Problem with Ray Casting

A naive approach casts a ray toward the wave source to check for land intersection. This fails for:

- **Lakes**: A ray from a lake might exit through the island and "see" open ocean
- **Infinite shadows**: No mechanism for shadows to diminish with distance

### Shadow Geometry Solution

For each wave direction, precompute the exact shadow regions as geometry:

#### Step 1: Find Silhouette Points

For each coastline contour (height=0), find points where the spline tangent is parallel to the wave direction. These are the "edges" of the coastline from the wave's perspective.

```
Wave direction: →

         Silhouette point (tangent ∥ wave dir)
                ↓
        ╭───────•───────╮
       ╱                 ╲
      │     Island        │
       ╲                 ╱
        ╰───────•───────╯
                ↑
         Silhouette point
```

For a Catmull-Rom spline segment from P0 through P1, P2 to P3, the tangent at parameter t is:

```
tangent(t) = 0.5 * (
    (-P0 + P2) +
    2 * (2*P0 - 5*P1 + 4*P2 - P3) * t +
    3 * (-P0 + 3*P1 - 3*P2 + P3) * t²
)
```

Silhouette points occur where `dot(tangent, waveDir) = 0`.

#### Step 2: Classify Silhouette Points

Each silhouette point is either:
- **Shadow-casting**: The coastline curves "away" from the wave here (starts a shadow)
- **Shadow-ending**: The coastline curves "toward" the wave here (ends a shadow)

Determined by the sign of `dot(tangent', waveDir)` (rate of change of alignment).

#### Step 3: Generate Shadow Boundary Lines

From each shadow-casting silhouette point, extend a line in the wave direction. This line is a shadow boundary.

```
Wave direction: →

    Silhouette pt →  •════════════════════► Shadow boundary line
                    ╱
        ╭─────────╱─────╮
       ╱                 ╲
      │     Island        │   Shadow region
       ╲                 ╱    (between boundary lines)
        ╰─────────╲─────╯
                   ╲
    Silhouette pt →  •════════════════════► Shadow boundary line
```

#### Step 4: Build Shadow Polygons

Connect shadow boundary lines with the coastline segments between silhouette points to form closed shadow polygons. Clip at map boundaries or where shadows intersect other coastlines.

### Shadow Recovery (Diffraction Filling)

Shadows don't extend forever. Diffraction from both edges of an obstacle eventually fills the shadow. The recovery distance depends on obstacle width and wavelength:

```
recoveryDistance ≈ obstacleWidth² / wavelength
```

For points beyond the recovery distance, shadow influence diminishes:

```
shadowStrength = 1.0 - smoothstep(0.5 * recoveryDistance, recoveryDistance, distanceBehindObstacle)
```

The obstacle width can be computed as the distance between the two silhouette points that bound the shadow region.

### Runtime Shadow Test

```wgsl
struct BoundaryContribution {
    silhouettePoint: vec2f,      // the diffracting edge point
    distanceToBoundary: f32,     // perpendicular distance to this boundary
    distanceBehind: f32,         // distance behind this silhouette point
    energy: f32,                 // diffraction energy from this edge
}

struct ShadowInfo {
    inShadow: bool,
    obstacleWidth: f32,
    // Contributing boundaries (up to 2 for a gap, 1 for single edge)
    boundaryCount: u32,
    boundaries: array<BoundaryContribution, 2>,
}

fn testShadow(worldPos: vec2f, waveDir: vec2f, wavelength: f32) -> ShadowInfo {
    var result = ShadowInfo(false, 0.0, 0, array<BoundaryContribution, 2>());

    // For each shadow polygon (precomputed for this wave direction):
    for each shadowPolygon in shadowPolygons:
        if (pointInPolygon(worldPos, shadowPolygon)):
            result.inShadow = true;
            result.obstacleWidth = shadowPolygon.obstacleWidth;

            // Find contributing shadow boundaries
            // (typically 1 for behind a headland, 2 for in a gap/bay)
            for each boundary in shadowPolygon.boundaries:
                let distToBoundary = distanceToLine(worldPos, boundary);
                let distBehind = distanceAlongWaveDir(worldPos, boundary.origin);

                // Only count boundaries we're "behind" (positive distance along wave dir)
                if (distBehind > 0.0) {
                    let energy = computeDiffraction(distToBoundary, distBehind, wavelength);

                    if (result.boundaryCount < 2) {
                        result.boundaries[result.boundaryCount] = BoundaryContribution(
                            boundary.origin,
                            distToBoundary,
                            distBehind,
                            energy
                        );
                        result.boundaryCount += 1;
                    }
                }

            return result;

    return result;
}
```

---

## Analytical Terrain Computations

### Water Depth

Computed using the same algorithm as `TerrainStateShader`: find the containing contour via winding number, then IDW blend with children.

```wgsl
fn computeWaterDepth(worldPos: vec2f) -> f32 {
    // Find containing contour (highest depth in hierarchy)
    var containingContour = -1;
    var maxDepth = -1;

    for (var i = 0u; i < contourCount; i++) {
        if (contours[i].height <= 0.0) { continue; }  // skip water contours for containment

        let winding = computeWindingNumber(worldPos, i);
        if (winding != 0 && contours[i].depth > maxDepth) {
            containingContour = i;
            maxDepth = contours[i].depth;
        }
    }

    if (containingContour < 0) {
        // In open water - IDW blend to nearest coastlines
        return computeOpenWaterDepth(worldPos);
    }

    // IDW blend between containing contour and its children
    return computeIDWHeight(worldPos, containingContour);
}
```

### Coastal SDF (Distance to Coastline)

Iterate over coastline contours and find minimum distance to any spline segment.

```wgsl
fn computeCoastalSDF(worldPos: vec2f) -> f32 {
    var minDist = 1e10;

    for each coastlineContour:  // only height=0 contours
        // Bounding box early-out
        if (!expandedBoundsContain(coastlineContour.bounds, worldPos, minDist)):
            continue;

        for each splineSegment in coastlineContour:
            let dist = distanceToSplineSegment(worldPos, splineSegment);
            minDist = min(minDist, dist);

    // Sign: negative inside land, positive in water
    let inLand = isInsideAnyCoastline(worldPos);
    return select(minDist, -minDist, inLand);
}

fn distanceToSplineSegment(p: vec2f, seg: SplineSegment) -> f32 {
    // Subdivide Catmull-Rom segment and find closest point
    var minDist = 1e10;

    for (var i = 0u; i < SPLINE_SUBDIVISIONS; i++) {
        let t0 = f32(i) / f32(SPLINE_SUBDIVISIONS);
        let t1 = f32(i + 1) / f32(SPLINE_SUBDIVISIONS);

        let a = catmullRomPoint(seg.p0, seg.p1, seg.p2, seg.p3, t0);
        let b = catmullRomPoint(seg.p0, seg.p1, seg.p2, seg.p3, t1);

        let dist = pointToSegmentDistance(p, a, b);
        minDist = min(minDist, dist);
    }

    return minDist;
}
```

### Land/Water Test

```wgsl
fn isLand(worldPos: vec2f) -> bool {
    // Check if inside any coastline contour (height=0)
    for each coastlineContour:
        if (computeWindingNumber(worldPos, coastlineContour) != 0):
            return true;
    return false;
}
```

---

## Diffraction Model

Diffraction occurs at shadow boundaries. The energy that diffracts into the shadow zone follows Fresnel diffraction physics.

### Fresnel Diffraction

For a point in shadow:

```wgsl
fn computeDiffraction(
    distanceToShadowBoundary: f32,  // perpendicular distance to nearest shadow edge
    distanceBehindObstacle: f32,    // how far past the diffracting edge
    wavelength: f32,
) -> f32 {
    // Fresnel parameter
    // u = x * sqrt(2 / (λ * z))
    let u = distanceToShadowBoundary * sqrt(2.0 / (wavelength * max(distanceBehindObstacle, 1.0)));

    // Fresnel intensity approximation
    // At boundary (u=0): energy ≈ 0.25
    // Deep in shadow (u >> 0): energy → 0
    // In light (u << 0): energy → 1

    if (u < -2.0) {
        return 1.0;  // fully illuminated
    } else if (u > 4.0) {
        return 0.0;  // deep shadow
    } else {
        // Approximate using error function
        let t = u * 0.7;
        return 0.5 * (1.0 - erf(t));
    }
}
```

### Combined Shadow + Diffraction

The shadow test now returns detailed boundary information, and both energy and direction are computed together. See the Main Algorithm section for the complete implementation.

Key points:
- `testShadow()` returns up to 2 contributing boundaries with their silhouette points
- Each boundary contributes both energy (Fresnel) and direction (Huygens)
- Energy and direction both recover toward original values as shadow fills in

### Wavelength Dependence

- **Long wavelengths** (swell, ~200-500ft): Diffract significantly, shadows fill in quickly
- **Short wavelengths** (chop, ~10-50ft): Less diffraction, sharper/longer shadows

This matches real physics: long ocean swells bend around islands, while short wind chop creates distinct shadows.

### Directional Diffraction (Huygens' Principle)

Diffraction doesn't just reduce wave energy - it also changes wave direction. Each diffracting edge acts as a new wave source (Huygens' principle). In the shadow zone, waves appear to emanate from the silhouette points:

```
Wave source: →→→→→

        ████████•←── Silhouette point
        ████████     (waves appear to come FROM here)
        ████████      ╲
                       ╲  Diffracted wave direction
                        ╲ (away from silhouette point)
                         ↘
                          ↘
```

**Single edge (headland):**
Waves in the shadow bend around the edge. The diffracted wave direction at any point is approximately the vector from the silhouette point toward that point.

**Two edges (gap/inlet):**
Waves diffract from both edges. The resulting wave direction is a weighted blend based on each edge's energy contribution:

```
        ████████•         •████████
        ████████           ████████
              ╲    Gap    ╱
               ╲         ╱
                ╲       ╱
                 ↘     ↙
                  ↘   ↙   ← Blended direction
                   ↘ ↙      from both edges
                    ↓
```

**Computing diffracted wave direction:**

```wgsl
fn computeDiffractedDirection(
    worldPos: vec2f,
    originalDir: vec2f,
    shadow: ShadowInfo,
    wavelength: f32,
) -> vec2f {
    if (!shadow.inShadow || shadow.boundaryCount == 0) {
        return originalDir;  // not in shadow, keep original direction
    }

    var weightedDir = vec2f(0.0, 0.0);
    var totalWeight = 0.0;

    // Each contributing boundary influences the wave direction
    for (var i = 0u; i < shadow.boundaryCount; i++) {
        let boundary = shadow.boundaries[i];

        // Direction from silhouette point toward current position
        let toPoint = worldPos - boundary.silhouettePoint;
        let dist = length(toPoint);
        if (dist < 1.0) { continue; }

        let diffractedDir = toPoint / dist;

        // Weight by diffraction energy from this edge
        let weight = boundary.energy;
        weightedDir += diffractedDir * weight;
        totalWeight += weight;
    }

    if (totalWeight < 0.001) {
        return originalDir;
    }

    // Normalize the blended direction
    let blendedDir = normalize(weightedDir);

    // Shadow recovery: blend back toward original direction as shadow fills in
    let recoveryDist = shadow.obstacleWidth * shadow.obstacleWidth / wavelength;
    let avgDistBehind = (shadow.boundaries[0].distanceBehind +
                         select(0.0, shadow.boundaries[1].distanceBehind, shadow.boundaryCount > 1))
                        / f32(shadow.boundaryCount);
    let recoveryFactor = smoothstep(0.5 * recoveryDist, recoveryDist, avgDistBehind);

    // Blend from diffracted direction toward original as shadow recovers
    return normalize(mix(blendedDir, originalDir, recoveryFactor));
}
```

**Why this works for all cases:**

| Geometry | Result |
|----------|--------|
| Behind headland | 1 edge → waves bend around the corner |
| In bay/inlet | 2 edges → waves radiate from inlet center |
| Behind small island | 2 edges → waves rejoin, blend back to original direction |
| Far behind any obstacle | Recovery factor → original direction restored |

---

## Shoaling

Waves grow taller in shallow water due to energy conservation.

```wgsl
fn computeShoaling(waterDepth: f32, wavelength: f32) -> f32 {
    // Green's Law: H2/H1 = (d1/d2)^(1/4)
    let referenceDepth = 100.0;  // deep water reference

    // Shoaling only applies in shallow water (depth < λ/2)
    let shallowThreshold = wavelength * 0.5;

    if (waterDepth > shallowThreshold) {
        return 1.0;  // deep water
    }

    // Transition into shallow water behavior
    let shallowFactor = 1.0 - smoothstep(shallowThreshold * 0.5, shallowThreshold, waterDepth);

    // Green's law factor
    let greenFactor = pow(referenceDepth / max(waterDepth, 1.0), 0.25);

    // Clamp to prevent infinite growth
    let maxShoaling = 2.0;
    return 1.0 + (min(greenFactor, maxShoaling) - 1.0) * shallowFactor;
}
```

---

## Refraction

Waves bend toward shallower water because the shallow portion slows down.

Since we compute depth analytically, we can use `dpdx`/`dpdy` (screen-space derivatives) to get the depth gradient for free:

```wgsl
fn computeRefraction(
    worldPos: vec2f,
    waveDir: vec2f,
    waterDepth: f32,
) -> f32 {
    // Get depth gradient using screen-space derivatives
    // (GPU computes these automatically for any varying value)
    let depthGradX = dpdx(waterDepth);
    let depthGradY = dpdy(waterDepth);

    // Convert screen gradient to world gradient
    let worldGradX = dpdx(worldPos.x);
    let worldGradY = dpdy(worldPos.y);

    let depthGrad = vec2f(
        depthGradX / worldGradX,
        depthGradY / worldGradY
    );

    // Wave bends toward shallower water
    let gradMag = length(depthGrad);
    if (gradMag < 0.001) {
        return 0.0;  // flat bottom
    }

    let gradDir = depthGrad / gradMag;

    // Bend angle proportional to cross product (sin of angle between wave and gradient)
    let crossProduct = waveDir.x * gradDir.y - waveDir.y * gradDir.x;

    // Stronger refraction in shallow water
    let refractionStrength = 0.1;
    let depthFactor = 1.0 / max(waterDepth * 0.1, 1.0);

    return clamp(crossProduct * gradMag * refractionStrength * depthFactor, -0.3, 0.3);
}
```

---

## Shallow Water Damping

Very shallow water absorbs wave energy through bottom friction.

```wgsl
fn computeShallowDamping(waterDepth: f32) -> f32 {
    let dampingThreshold = 10.0;  // feet
    return smoothstep(0.0, dampingThreshold, waterDepth);
}
```

---

## Reflection (Optional)

Steep shores reflect waves. This could be computed analytically by:

1. Finding nearby coastline segments
2. Computing the shore slope from contour heights
3. Determining reflectivity based on slope steepness

```wgsl
fn computeReflection(
    worldPos: vec2f,
    waveDir: vec2f,
    wavelength: f32,
) -> f32 {
    let sdf = computeCoastalSDF(worldPos);
    let maxReflectionDist = wavelength * 2.0;

    if (sdf > maxReflectionDist) {
        return 0.0;  // too far from shore
    }

    // Find nearest coastline point and compute shore slope
    let shoreInfo = findNearestShoreInfo(worldPos);

    // Steep shores reflect more
    // shoreSlope is the height gradient perpendicular to coastline
    let reflectivity = smoothstep(0.3, 1.5, shoreInfo.slope);

    // Perpendicular incidence reflects more
    let incidenceAngle = abs(dot(waveDir, shoreInfo.normal));

    // Decay with distance
    let distanceFactor = 1.0 - sdf / maxReflectionDist;

    return reflectivity * incidenceAngle * distanceFactor;
}
```

For full reflection, you'd also need to trace reflected wave paths - this adds complexity and may not be worth it for gameplay.

---

## Main Algorithm

```wgsl
struct WaveModification {
    energyFactor: f32,
    newDirection: vec2f,  // fully modified direction (diffraction + refraction)
}

fn computeWaveModification(
    worldPos: vec2f,
    waveDir: vec2f,
    wavelength: f32,
) -> WaveModification {
    // Check if on land
    if (isLand(worldPos)) {
        return WaveModification(0.0, waveDir);
    }

    // Compute water depth analytically
    let depth = computeWaterDepth(worldPos);
    let waterDepth = -depth;  // positive value

    // 1. Shadow test (includes diffraction energy calculation)
    let shadow = testShadow(worldPos, waveDir, wavelength);

    // 2. Compute diffraction energy with recovery
    var shadowEnergy = 1.0;
    if (shadow.inShadow && shadow.boundaryCount > 0) {
        // Use energy from nearest boundary as base
        let baseEnergy = shadow.boundaries[0].energy;

        // Shadow recovery
        let recoveryDist = shadow.obstacleWidth * shadow.obstacleWidth / wavelength;
        let avgDistBehind = shadow.boundaries[0].distanceBehind;
        let recoveryFactor = smoothstep(0.5 * recoveryDist, recoveryDist, avgDistBehind);

        shadowEnergy = mix(baseEnergy, 1.0, recoveryFactor);
    }

    // 3. Compute diffracted wave direction
    let diffractedDir = computeDiffractedDirection(worldPos, waveDir, shadow, wavelength);

    // 4. Shoaling
    let shoalingFactor = computeShoaling(waterDepth, wavelength);

    // 5. Damping
    let dampingFactor = computeShallowDamping(waterDepth);

    // 6. Refraction (applied to already-diffracted direction)
    let refractionOffset = computeRefraction(worldPos, diffractedDir, waterDepth);
    let finalDir = rotateVector(diffractedDir, refractionOffset);

    // Combine energy factors
    let totalEnergy = shadowEnergy * shoalingFactor * dampingFactor;

    return WaveModification(totalEnergy, finalDir);
}

fn rotateVector(v: vec2f, angle: f32) -> vec2f {
    let c = cos(angle);
    let s = sin(angle);
    return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}
```

### Integration with Wave Rendering

When computing wave height for rendering:

```wgsl
fn computeWaveContribution(pos: vec2f, wave: WaveParams, time: f32) -> f32 {
    // Get terrain modification for this wave
    let mod = computeWaveModification(pos, wave.direction, wave.wavelength);

    // Use the new direction (includes diffraction + refraction)
    let phase = dot(mod.newDirection, pos) * wave.frequency - time * wave.speed;

    // Apply energy factor to amplitude
    return wave.amplitude * mod.energyFactor * sin(phase);
}
```

This means waves in a bay will naturally:
1. Have reduced energy (diffraction attenuation)
2. Appear to come from the inlet (diffracted direction)
3. Spread out radially (each point gets direction from its silhouette point)
4. Eventually recover original direction far behind (recovery factor)

---

## Performance Considerations

### Costs Per Pixel

| Operation | Cost |
|-----------|------|
| Water depth (IDW) | O(contours × children × spline_subdivisions) |
| Coastal SDF | O(coastline_contours × spline_subdivisions) |
| Shadow test | O(shadow_polygons) |
| Diffraction | O(1) |
| Shoaling/damping | O(1) |
| Refraction | O(1) - uses derivatives |

### Optimizations

**1. Bounding box acceleration**

Pre-compute AABB for each contour. Skip contours whose expanded bounds don't contain the query point.

```wgsl
if (worldPos.x < bounds.min.x - currentMinDist ||
    worldPos.x > bounds.max.x + currentMinDist ||
    worldPos.y < bounds.min.y - currentMinDist ||
    worldPos.y > bounds.max.y + currentMinDist) {
    continue;  // can't be closer
}
```

**2. Early land rejection**

If a point is deep in the ocean (far from any coastline), many computations can be skipped:

```wgsl
let sdf = computeCoastalSDF(worldPos);
if (sdf > DEEP_OCEAN_THRESHOLD) {
    // Far from any coast - no shadow, no shoaling, no refraction
    return WaveModification(1.0, 0.0);
}
```

**3. Direction interpolation**

Pre-compute shadow geometry for 16 directions. At runtime, interpolate between the two nearest precomputed directions rather than computing exact shadow for arbitrary angles.

**4. Hierarchical shadow test**

For complex coastlines with many shadow polygons, use a spatial index (grid or BVH) for fast polygon lookup.

**5. LOD based on screen coverage**

For distant pixels covering large world areas, use simplified computations.

### Expected Performance

- **Open ocean**: Very fast (early SDF rejection)
- **Near simple coastline**: Moderate (few contours to check)
- **Complex archipelago**: More expensive (many contours and shadow polygons)

The analytical approach trades computation for memory and precision. For typical game terrain with 10-50 contours, this should be well within performance budget.

---

## Implementation Plan

### Phase 1: Coastline Infrastructure

1. Add editor constraint: positive-height contours must have height=0 parent before negative-height parent
2. Create `CoastlineManager` that tracks height=0 contours
3. Pre-compute bounding boxes for all coastline contours

### Phase 2: Shadow Geometry

1. Implement silhouette point detection (tangent ∥ wave direction)
2. Generate shadow boundary lines from silhouette points
3. Build shadow polygons
4. Implement point-in-shadow-polygon test

### Phase 3: Analytical Computations in Shader

1. Port contour data to GPU buffers (control points, metadata)
2. Implement analytical water depth in water shader
3. Implement analytical coastal SDF
4. Implement land/water test

### Phase 4: Wave Physics

1. Add shadow + diffraction computation
2. Add shoaling
3. Add damping
4. Add refraction

### Phase 5: Polish

1. Tune diffraction parameters for visual quality
2. Optimize hot paths
3. Add bounding box acceleration
4. Profile and optimize

### Phase 6 (Optional): Reflection

1. Compute shore slope from contour geometry
2. Implement reflection zones
3. Add reflected wave contribution

---

## Comparison with Previous Approaches

| Aspect | Grid-Based (Current) | Ray March (Previous Design) | Analytical (This Design) |
|--------|---------------------|----------------------------|-------------------------|
| Memory | 8.5MB+ (3D textures) | ~6MB (2D textures) | Minimal (geometry only) |
| Resolution | Fixed 50-100ft | Per-pixel | Per-pixel, exact |
| Shadow accuracy | Grid-limited | Ray discretization | Mathematically exact |
| Lake handling | Incorrect | Incorrect | Correct |
| Shadow recovery | None (infinite) | Distance-based | Physics-based |
| Diffraction energy | Wrong model | Fresnel approximation | Fresnel with exact boundaries |
| Diffraction direction | None | None | Huygens principle (waves bend around edges) |
| Bay/inlet behavior | Waves keep original direction | Waves keep original direction | Waves radiate from inlet |
| Artifacts | Grid boundaries | Ray stepping | None |
| Startup time | Seconds | Milliseconds | Milliseconds |
| Terrain changes | Full recompute | SDF recompute | Shadow geometry only |

---

## Data Structures

### GPU Buffers for Contours

```wgsl
struct ContourData {
    pointStartIndex: u32,
    pointCount: u32,
    height: f32,
    parentIndex: i32,
    depth: u32,  // hierarchy depth
    childStartIndex: u32,
    childCount: u32,
    // Bounding box
    boundsMin: vec2f,
    boundsMax: vec2f,
    // Flags
    isCoastline: u32,  // 1 if height == 0
}

@group(0) @binding(0) var<storage, read> controlPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read> contours: array<ContourData>;
@group(0) @binding(2) var<storage, read> children: array<u32>;
@group(0) @binding(3) var<storage, read> coastlineIndices: array<u32>;
```

### Shadow Geometry (Per Wave Direction)

```wgsl
struct ShadowBoundary {
    origin: vec2f,       // silhouette point
    direction: vec2f,    // wave direction (normalized)
    contourIndex: u32,   // which coastline this came from
    isLeftEdge: bool,    // left or right edge of shadow
}

struct ShadowPolygon {
    boundaryStartIndex: u32,
    boundaryCount: u32,
    obstacleWidth: f32,
    // Bounding box for quick rejection
    boundsMin: vec2f,
    boundsMax: vec2f,
}

@group(0) @binding(4) var<storage, read> shadowBoundaries: array<ShadowBoundary>;
@group(0) @binding(5) var<storage, read> shadowPolygons: array<ShadowPolygon>;
```

---

## Open Questions

1. **Spline subdivision count**: Higher = more accurate but slower. Need to profile to find sweet spot.

2. **Shadow polygon complexity**: For very complex coastlines, shadow polygons could have many vertices. May need simplification.

3. **Multiple wave sources**: Each wave source needs its own shadow test. With 2-3 swell sources, this triples the shadow work.

4. **Wind chop**: Many small wave components. May not be worth full shadow computation for each - perhaps use simplified model.

5. **Dynamic obstacles**: Boats, etc. These can't use precomputed shadow geometry. May need separate handling.

---

## References

- Catmull-Rom splines: https://en.wikipedia.org/wiki/Centripetal_Catmull%E2%80%93Rom_spline
- Fresnel Diffraction: https://en.wikipedia.org/wiki/Fresnel_diffraction
- Green's Law (shoaling): https://en.wikipedia.org/wiki/Green%27s_law
- Wave refraction: https://en.wikipedia.org/wiki/Wave_refraction
- Point-in-polygon: https://en.wikipedia.org/wiki/Point_in_polygon
- Error function approximation: Abramowitz and Stegun, Handbook of Mathematical Functions
