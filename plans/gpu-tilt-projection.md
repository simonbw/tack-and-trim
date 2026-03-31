# GPU-Driven Tilt Projection Refactor

## Current State

Boat components each manually compute their 3D→2D projection on the CPU, duplicating the tilt rotation math across 8+ files. Z-values for the depth buffer are computed separately, leading to bugs where z gets out of sync with the 2D position (water rendering over the hull, boom clipping through deck, etc.).

The renderer already supports GPU-driven projection via the vertex shader:
```wgsl
worldX = modelCol0.x * position.x + modelCol1.x * position.y + zCoeffs.x * z + modelCol2.x;
worldY = modelCol0.y * position.x + modelCol1.y * position.y + zCoeffs.y * z + modelCol2.y;
depth  = (z - Z_MIN) / (Z_MAX - Z_MIN);
```

The model matrix columns map to the TiltTransform's xy-columns, and zCoeffs maps to the z-column. Per-vertex z is already stored per vertex. `draw.at()` already accepts a `tilt` parameter, but its implementation uses the old simplified `scaleY(cosR)` instead of the correct `R_pitch * R_roll` matrix.

### Key files and current approach:
- `src/core/graphics/Draw.ts:278-307` — `draw.at({ tilt })` composes `translate × rotate × scaleY(cosR)` and computes zCoeffs from the old simplified formula (`ca*sp - sa*sr`, `sa*sp + ca*sr`)
- `src/game/boat/TiltTransform.ts` — Correct 2×3 matrix already computed in `update()`, with proper `toWorld3D()` and `worldZ` row
- `src/game/boat/Hull.ts` — Manual `projectMesh()` on CPU, then `submitTrianglesWithZ()` for per-vertex z
- `src/game/boat/Keel.ts` — Manual `worldOffset(keelZ)` for parallax
- `src/game/boat/Rudder.ts` — Manual `worldOffset(-1)` for parallax
- `src/game/boat/Lifelines.ts` — Manual `projX(x,y,z)` / `projY(y,z)` helpers
- `src/game/boat/HullDamage.ts` — Manual projection per scratch
- `src/game/boat/Bilge.ts` — Manual per-vertex projection in `computeWaterPolygon`
- `src/game/boat/Rig.ts` — Manual `toWorld3D()` for boom, manual `projectStay()` for rigging
- `src/game/boat/Sheet.ts` — Manual `worldOffsetX/Y(z)` per rope point
- `src/game/boat/Bowsprit.ts` — Manual `worldOffset(bowspritZ)`

## Desired Changes

**Goal:** Components draw in hull-local body coordinates with z = their 3D height. The GPU handles both 2D projection (parallax) and depth buffer writes automatically via the model matrix + zCoeffs.

**Approach:**
1. Fix `draw.at({ tilt })` to use the correct rotation matrix (matching TiltTransform)
2. Add `zOffset` to the tilt parameter so bb.z is handled automatically
3. Add `worldZ(x, y, z)` helper on TiltTransform for components that still need manual z (boom angle computation, etc.)
4. Migrate components from manual CPU projection to `draw.at({ tilt })` + z-height

**After the refactor:**
- `projectMesh()` and `submitTrianglesWithZ()` are eliminated
- Most components no longer import or read tilt transform trig values
- Z-values are automatically correct everywhere — no more z-sync bugs
- `TiltTransform.localOffset()`, `worldOffset()`, `worldOffsetX/Y()` can be removed (no longer needed)

## Files to Modify

### Core infrastructure
- `src/core/graphics/Draw.ts` — Fix `draw.at({ tilt })` to compose the correct `R_pitch * R_roll` model matrix and z-column zCoeffs. Add `zOffset` field to the tilt options. The model matrix should be: `translate(pos) × [correct 2×2 rotation with pitch/roll/yaw]`, and zCoeffs should be the z-column of the full rotation, transformed through the camera matrix.
- `src/game/boat/TiltTransform.ts` — Add `worldZ(x, y, z, zOffset?)` helper that returns `x*sinP - y*sinR*cosP + z*cosR*cosP + zOffset`. Remove `localOffset()`, `worldOffset()`, `worldOffsetX()`, `worldOffsetY()` once no longer used.

### Hull (biggest win)
- `src/game/boat/Hull.ts` — Replace the `projectMesh()` + `submitTrianglesWithZ()` approach. Instead, build a static `[number, number][]` array of (x, y) positions from the mesh (one-time, not per-frame), and a static `number[]` of z-heights. Use `draw.at({ pos, angle, tilt: { roll, pitch, zOffset } })` and submit raw body-local vertices with per-vertex z via `submitTrianglesWithZ`. Remove `projectMesh()` entirely. The mesh's `projected` and `worldZ` arrays become unnecessary — just keep `positions`, and derive static xy and z arrays from it at construction. Tiller rendering switches from manual projection to using the tilt context's z.

### Simple components (draw in tilt context, set z)
- `src/game/boat/Keel.ts` — Replace `worldOffset(keelZ)` parallax with `draw.at({ tilt })` and `setZ(keelZ + zOffset)`. Draw the polyline in body-local coords.
- `src/game/boat/Rudder.ts` — Replace `worldOffset(-1)` with `draw.at({ tilt })` or use `tiltTransform.worldZ()` for the z-value. Note: rudder has its own physics body with independent angle, so it needs its own `draw.at` for position/angle, but can use tilt's `worldZ()` for depth.
- `src/game/boat/Bowsprit.ts` — Replace manual `worldOffset(bowspritZ)` with `draw.at({ tilt })` and `setZ(bowspritZ + zOffset)`.
- `src/game/boat/HullDamage.ts` — Remove manual projection (`cp`, `sp`, `sr`, `cr` locals). Draw inside the tilt-aware `draw.at()` with `setZ(scratchZ + zOffset)`.
- `src/game/boat/Lifelines.ts` — Remove `projX`/`projY` helpers. Draw inside tilt-aware `draw.at()` with z set per element (deck height, rail height).

### Medium complexity
- `src/game/boat/Bilge.ts` — The water polygon clipping still needs CPU-side work (determining which vertices are above/below water). But the projection of the final polygon vertices can use the tilt context. The clipping comparison needs `worldZ()` to determine submersion.
- `src/game/boat/Sheet.ts` — Rope points are in world space (from Verlet sim), not hull-local. The z-offset per point can use `tiltTransform.worldZ()` for depth, but the 2D positions come from the sim. Main change: replace `worldOffsetX/Y(z)` calls with direct z-setting.
- `src/game/boat/Rig.ts` — Boom: keep computing 2D endpoints manually (boom has independent rotation). Use `tiltTransform.worldZ()` for boom depth. Mast: use `worldZ()` for depth at mast position. Standing rigging: draw inside tilt-aware `draw.at()` with z = deckHeight. Remove `projectStay()`.

### No changes needed
- `src/game/boat/sail/Sail.ts` — Cloth solver outputs world-space 2D positions; separate rendering pipeline. Leave as-is.

## Execution Order

### Phase 1: Infrastructure (sequential — everything depends on this)
1. **`Draw.ts`**: Fix `draw.at({ tilt })` to compose the correct model matrix:
   - The current code does: `translate(pos) → rotate(angle) → scale(1, cosR)` → set zCoeffs
   - The correct code should do: `translate(pos)` → then directly set the model matrix to the full tilt rotation (incorporating angle, pitch, roll) → set zCoeffs from the z-column of the rotation
   - Add `zOffset: number` to the tilt type. This gets added to every z-value in the depth calculation. Implementation: when zOffset is set, add it to `currentZ` after save (so it acts as a z-bias for all draws within the context).
   - The 2×2 rotation part (before translation) is `R_yaw × R_pitch × R_roll`, taking just the xy-columns:
     ```
     a = ca*cp,              c = ca*sp*sr - sa*cr
     b = sa*cp,              d = sa*sp*sr + ca*cr
     ```
   - The zCoeffs (in world space, before camera transform) are:
     ```
     zx = -(ca*sp*cr + sa*sr)
     zy = -(sa*sp*cr - ca*sr)
     ```

2. **`TiltTransform.ts`**: Add `worldZ(x, y, z, zOffset = 0)` method.

### Phase 2: Hull (depends on Phase 1)
3. **`Hull.ts`**: Migrate to GPU-driven projection.
   - Build static `xyPositions: [number, number][]` and `zPositions: number[]` from `positions` at construction time
   - In `onRender`: use `draw.at({ pos, angle: body.angle, tilt: { roll, pitch, zOffset: bb.z } })`
   - Inside the tilt context, submit triangles with the static xy positions and z positions via `submitTrianglesWithZ(xyPositions, indices, color, alpha, zPositions)`
   - Remove `projectMesh()` function entirely
   - Remove the per-frame `worldZ` computation

### Phase 3: Simple components (parallel — all depend on Phase 1 only)
These can all be done independently:
4. **`Keel.ts`** — Use tilt-aware `draw.at()`, set z to keelZ + zOffset
5. **`Lifelines.ts`** — Use tilt-aware `draw.at()`, remove projX/projY
6. **`HullDamage.ts`** — Use tilt-aware `draw.at()`, remove manual projection
7. **`Bowsprit.ts`** — Use tilt-aware `draw.at()`, remove worldOffset
8. **`Rig.ts`** — Rigging: use tilt-aware `draw.at()`. Boom: use `worldZ()`. Mast: use `worldZ()`.
9. **`Rudder.ts`** — Use `worldZ()` for depth value
10. **`Sheet.ts`** — Replace `worldOffsetX/Y` with z-setting via `worldZ()`
11. **`Bilge.ts`** — Use `worldZ()` for submersion checks and final polygon z

### Phase 4: Cleanup (after all migrations)
12. Remove `TiltTransform.localOffset()`, `worldOffset()`, `worldOffsetX()`, `worldOffsetY()` if no longer referenced
13. Remove `WebGPURenderer.submitTrianglesWithZ()` if hull no longer needs it (or keep if hull still uses per-vertex z)
14. Remove `HullMesh.projected` and `HullMesh.worldZ` fields if no longer needed

## Notes

- `submitTrianglesWithZ` is still useful for the hull mesh even with the tilt context, because the hull has per-vertex z values (deck at 1.6, waterline at 0, bottom at -0.6). The tilt context handles the model matrix + zCoeffs, and per-vertex z feeds into both depth AND the zCoeffs parallax offset. So the hull submits body-local (x, y) with per-vertex z, and the GPU computes the correct world position and depth for each vertex.
- Components at a single fixed z-height (keel, tiller, boom) can just use `setZ(height + zOffset)` — no need for per-vertex z.
- The zOffset in the tilt parameter should be added to `currentZ` within the save/restore block, so all `setZ(localHeight)` calls within the context automatically include bb.z.
