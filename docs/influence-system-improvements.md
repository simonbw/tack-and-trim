# Influence System Improvements

This document tracks issues and improvement ideas for the terrain influence system (wind/wave effects).

## Current State

The influence system uses a relaxation-based propagation algorithm to compute how terrain affects wind and waves. Pre-computed influence fields are stored as 3D grids (x, y, direction) and uploaded to GPU as textures.

**What works well:**
- Blocking - binary water mask correctly stops energy at land boundaries
- Basic energy propagation architecture
- GPU texture representation with trilinear interpolation

**What needs work:**
- Diffraction looks weird near shorelines
- Tile-based computation is visibly obvious
- Shoaling not implemented
- Damping is only generic decay, not physics-based

---

## Issue 1: Visible Tile Boundaries

**Problem:** The 32ft grid resolution for swell (and 50ft for wind) is too coarse. Cell boundaries are visible as discrete steps in the influence field, especially along coastlines.

**Why it happens:**
- Energy values stored per-cell are discrete
- Trilinear interpolation smooths between cells but can't hide coarse resolution
- Fine coastal topology is lost at this resolution

**Potential fixes:**

### 1a. Increase Grid Resolution
Reduce cell size from 32ft to 16ft (or finer) for swell influence.

- **Pros:** Simple change, directly addresses the problem
- **Cons:** 4x memory usage, longer computation time
- **Files:** `src/game/world-data/influence/InfluenceFieldManager.ts` (resolution constants)

### 1b. Multi-Resolution Grids
Use coarse grid for open water, fine grid near coastlines.

- **Pros:** Best of both worlds - detail where needed, efficiency elsewhere
- **Cons:** More complex implementation, need to blend between resolutions
- **Files:** Would require significant refactoring of grid storage and sampling

### 1c. Better Interpolation
Use higher-order interpolation (bicubic/tricubic) instead of trilinear.

- **Pros:** Smoother results without increasing storage
- **Cons:** More expensive sampling, may not fully solve the problem
- **Files:** GPU shaders that sample influence textures

---

## Issue 2: Incorrect Direction Averaging

**Problem:** The arrival direction calculation uses weighted averaging via `atan2(Σ dirY × weight, Σ dirX × weight)`. This is mathematically incorrect for circular data.

**Why it matters:**
- If 50% of energy arrives from 0° and 50% from 180°, the average is meaningless
- Causes unstable/nonsensical directions in diffraction zones
- Contributes to "weird" behavior near shorelines

**Fix:** Use circular mean (sine/cosine accumulation):

```typescript
// Current (incorrect):
weightedDirX += normFlowDirX * contribution;
weightedDirY += normFlowDirY * contribution;
arrivalDirection = Math.atan2(totalWeightedDirY, totalWeightedDirX);

// Correct circular mean:
weightedSin += Math.sin(flowDirection) * contribution;
weightedCos += Math.cos(flowDirection) * contribution;
arrivalDirection = Math.atan2(weightedSin, weightedCos);
```

- **Files:** `src/game/world-data/influence/propagation/` - the propagation worker code

---

## Issue 3: Diffraction Model Too Simple

**Problem:** Diffraction uses hardcoded `lateralSpreadFactor` values (0.3 for long swell, 0.15 for short chop) that don't relate to actual physics.

**Why it matters:**
- Real diffraction depends on wavelength/obstacle ratio
- Long waves should diffract more around small obstacles
- Current model treats all obstacles the same regardless of size

**Potential fixes:**

### 3a. Wavelength-Based Spreading Factor
Scale lateral spread factor based on wavelength relative to local obstacle scale.

```typescript
// Pseudocode
const obstacleScale = estimateLocalObstacleScale(x, y); // from terrain
const diffractionParam = wavelength / obstacleScale;
const lateralSpread = baseLateralSpread * Math.min(1.0, diffractionParam);
```

- **Pros:** More physically accurate
- **Cons:** Need to compute/estimate obstacle scale from terrain

### 3b. Huygens Principle Implementation
Treat each wave front point as a source of secondary wavelets.

- **Pros:** Physically correct diffraction
- **Cons:** Significantly more complex, may require different algorithm entirely

---

## Issue 4: Shoaling Not Implemented

**Problem:** There is no water depth data in the system. Without depth, shoaling (waves getting taller/steeper in shallow water) cannot be computed.

**What shoaling should do:**
- Waves slow down in shallow water
- Wavelength decreases (crests bunch up)
- Wave height INCREASES (energy conserved in smaller volume)
- Green's Law: `H₂/H₁ = (d₁/d₂)^(1/4)` - as depth halves, height increases ~19%

**Implementation steps:**

### 4a. Compute Water Depth
Derive depth from terrain elevation and sea level.

```typescript
// Pseudocode
const seaLevel = 0; // or dynamic based on tides
const terrainElevation = sampleTerrain(x, y);
const waterDepth = Math.max(0, seaLevel - terrainElevation);
```

- **Files:** Need to add depth computation to terrain system or influence system
- **Challenge:** Terrain elevation data may not extend underwater accurately

### 4b. Apply Shoaling Factor to Wave Amplitude
Scale wave amplitude based on depth relative to wavelength.

```typescript
// In shader or wave computation
const shallowWaterThreshold = wavelength / 2;
if (waterDepth < shallowWaterThreshold) {
    const shoalingFactor = Math.pow(shallowWaterThreshold / waterDepth, 0.25);
    amplitude *= shoalingFactor;
}
```

- **Files:** `src/game/world-data/influence/` for computation, water shaders for rendering

---

## Issue 5: Damping is Generic, Not Physics-Based

**Problem:** The current `decayFactor` (0.97-0.985) applies uniform ~2-3% energy loss per cell everywhere. This doesn't model actual physical damping.

**What's missing:**
- Shallow water bottom friction (stronger damping in shallow areas)
- Bottom roughness effects (sandy vs rocky bottom)
- Breaking wave dissipation (very shallow water)

**Potential fixes:**

### 5a. Depth-Dependent Damping
Once depth data exists (Issue 4), apply stronger damping in shallow water.

```typescript
// Pseudocode
const baseDamping = 0.02; // 2% per cell
const shallowDampingMultiplier = 1.0 + Math.max(0, (10 - waterDepth) / 10); // More damping below 10ft
const totalDamping = baseDamping * shallowDampingMultiplier;
energy *= (1 - totalDamping);
```

### 5b. Bottom Friction Model
More sophisticated model based on orbital velocity reaching bottom.

```typescript
// Waves "feel" the bottom when depth < wavelength/2
const bottomInteraction = Math.max(0, 1 - (2 * waterDepth / wavelength));
const frictionDamping = bottomInteraction * bottomFrictionCoefficient;
```

- **Depends on:** Issue 4 (depth data)

---

## Issue 6: Fetch Model Limitations

**Problem:** Fetch (distance wind has blown over water) is computed via simple ray-march upwind. This has limitations:

- Linear ray doesn't curve for extreme wind angles
- Doesn't account for wind direction variation
- May not accurately represent complex coastline fetch

**Lower priority** - current implementation is reasonable for most cases.

---

## Suggested Implementation Order

1. **Issue 2: Fix direction averaging** - Low effort, high impact on diffraction weirdness
2. **Issue 1a: Increase grid resolution** - Medium effort, directly fixes visible tiling
3. **Issue 4: Add depth data + shoaling** - Medium effort, enables several other improvements
4. **Issue 5a: Depth-dependent damping** - Low effort once depth exists
5. **Issue 3a: Wavelength-based diffraction** - Medium effort, improves realism
6. **Issues 1b, 3b, 5b** - Higher effort, consider if simpler fixes aren't sufficient

---

## Files Reference

Key files in the influence system:

| File | Purpose |
|------|---------|
| `src/game/world-data/influence/InfluenceFieldManager.ts` | Main manager, orchestrates computation |
| `src/game/world-data/influence/InfluenceFieldGrid.ts` | 3D grid data structure |
| `src/game/world-data/influence/propagation/` | Worker code for propagation algorithm |
| `src/game/world-data/influence/propagation/TerrainSampler.ts` | Samples terrain for water mask |
| `src/game/water/` | Water rendering that consumes influence data |
