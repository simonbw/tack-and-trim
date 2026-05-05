# Global Lighting Everywhere

> **Status (2026):** implemented and shipped — see `plans/README.md`. The
> file references below describe the codebase as it was at the time of
> writing; in particular the per-pass `*Uniforms.ts` files have since been
> folded into the matching `*Shader.ts` files (the uniform structs are now
> exported from those `*Shader.ts` files), and `SceneLighting` is exposed
> via `src/game/time/SceneLighting.ts`. This document is preserved as a
> record of how the change was planned; it is not a guide to current code.

Extend the day/night lighting system (GitHub issue #146) to all world-space rendering. CPU owns the sun/sky math; every shader receives a shared `SceneLightingUniform`; the generic `Draw` API pipeline applies the global sun color per-vertex with a 0–1 opt-out flag so UI and debug overlays stay un-tinted.

---

## Current State

### Source of truth: WGSL only
- `src/game/world/shaders/scene-lighting.wgsl.ts:11` exports `fn_SCENE_LIGHTING` as a `ShaderModule` with WGSL-only implementations of `getSunAltitude`, `getSunDirection`, `getSunColor`, `getSkyColor`.
- Each consumer shader imports the module and calls the functions **per-pixel** with `params.time`.
- `TimeOfDay` (`src/game/time/TimeOfDay.ts:42`) exposes only `getTimeInSeconds()` / `getHour()` — no lighting values.

### Shaders already consuming `time`
- `WaterFilterShader` (`src/game/surface-rendering/WaterFilterShader.ts`) — uses `getSunColor`/`getSkyColor`/`getSunDirection` via `fn_waterSurfaceLight`. Bilge-water coloring also happens here via the `airMin`/`airMax` substitution at line 283, so bilge already benefits from sky lighting once migrated.
- `TerrainCompositeShader` — calls `renderTerrain(..., params.time)` (`src/game/world/shaders/terrain-rendering.wgsl.ts:44`). Applies `getSunDirection` for diffuse lighting but does **not** multiply by `getSunColor`.
- `SailShader` (`src/game/boat/sail/SailShader.ts:75`) — **inlines** its own `getSunDirection` (duplicated copy), cel-shades only.

### Shaders NOT consuming `time`
- `RopeShader` (`src/game/boat/RopeShader.ts`) — carrier colors hardcoded in uniforms, no lighting.
- `TreeRasterizer` (`src/game/trees/TreeRasterizer.ts`) — already has `time` and `timeOfDay` uniforms (lines 68, 77, 98, 107) used only for wind sway animation; no lighting modulation.
- `BoatAirShader` (`src/game/surface-rendering/BoatAirShader.ts`) — geometric-only pass writing `airMin`/`airMax`/`turbulence` to a rgba16float texture that WaterFilterShader reads. No visible color output of its own, so **out of scope**. The bilge's visible color is painted by WaterFilterShader and will pick up lighting automatically once that shader is migrated.

### Draw API (generic shape pipeline)
- **Vertex format**: 7 floats = `position(2) + color(4) + z(1) = 28 bytes/vertex`. Stride constant: `VERTEX_STRIDE_FLOATS = 7` at `src/core/graphics/tessellation/VertexSink.ts:38`.
- **Single write choke-point**: `writeVertex(view, i, x, y, r, g, b, a, z)` at `VertexSink.ts:43`. Every tessellator calls this.
- **Tessellators** (9 files in `src/core/graphics/tessellation/`): `circle`, `rectangle`, `line`, `polyline`, `polygon`, `roundedPolygon`, `smoothPolygon`, `spline`, `screenCircle`. All call `unpackColor(color, alpha)` then `writeVertex(...)`.
- **Both ShapeBatch and MeshBuilder** (`src/core/graphics/webgpu/ShapeBatch.ts:48`, `src/core/graphics/MeshBuilder.ts:53`) allocate Float32Arrays sized by `VERTEX_STRIDE_FLOATS` — same stride for immediate-mode and retained-mode. `CachedMesh` and `DynamicMesh` share it too.
- **Renderer shape shader** (`WebGPURenderer.ts:63`): vertex has `@location(0) position`, `@location(1) color`, `@location(2) z`, `@location(3) transformIndex`. Fragment output is `in.color`. There's already a per-instance `tint: vec4<f32>` in the transform struct (WebGPURenderer.ts:58).
- **`prepareShapeSink()`** (`WebGPURenderer.ts:1233`) is the single entry point through which every tessellator-driven draw call passes — natural place to ensure the global lighting uniform is fresh.
- Two direct-write paths bypass tessellators: `submitTriangles` (WebGPURenderer.ts:1871) and `submitColoredTriangles` (WebGPURenderer.ts:1929) — both manually write 7 floats per vertex.

### DrawOptions / API surface
- `DrawOptions` at `Draw.ts:47` has `color`, `alpha`, `z`.
- `LineOptions`, `SmoothOptions`, `SplineOptions`, `CircleOptions` all extend it — adding a field to `DrawOptions` flows through automatically.
- `ImageOptions` (sprite path) is **separate** and goes through `SpriteBatch` — not in scope for this PR.

### World `draw.*` consumers (will pick up lighting automatically)
Files using `draw.*` to render world content: `WindParticles.ts`, `Buoy.ts`, `Anchor.ts`, `Bilge.ts`, `BoatRenderer.ts`, `HullDamage.ts`, `Sailor.ts`, `TellTail.ts`, `TiltDraw.ts`, `Mooring.ts`, `Port.ts`, `ClothRenderer.ts`, `Sail.ts` (mostly indirectly via `TiltDraw`).

### Draw.* consumers that MUST opt out
- `src/game/debug-renderer/modes/WaterHeightDebugMode.ts` — `draw.fillRect`, `draw.strokeCircle`, `draw.fillCircle` (debug overlay).
- `src/game/debug-renderer/modes/WindFieldDebugMode.ts` — debug overlay.
- `src/editor/ContourRenderer.ts` — standalone editor, should stay at full brightness.
- `src/boat-editor/BoatPreviewRenderer.ts` — standalone editor.
- `src/rope-test/RopeTestController.ts` — test harness.
- Any other `draw.*` call in the `debug-renderer/`, `editor/`, `boat-editor/`, `rope-test/` trees.
- Note: React-based HUDs (`TimeOfDayHUD.tsx`, `NavigationHUD.tsx`, `BoatDebugHUD.tsx`, etc.) render through the DOM, not the Draw API — already free.

### Layers
`src/config/layers.ts` defines `boat`, `surface`, `wake`, `trees`, `windParticles`, `windViz`, `hud`, `debugHud`. **Layer-based opt-out is an explicit non-goal for this PR** (flagged as a future enhancement). Per-call `ignoreLight: true` is the opt-out mechanism.

---

## Desired Changes

### End state
1. **`TimeOfDay` owns the math.** CPU port of `getSunAltitude`, `getSunDirection`, `getSunColor`, `getSkyColor` lives on the `TimeOfDay` entity. The WGSL functions in `scene-lighting.wgsl.ts` are deleted.
2. **One shared uniform struct.** `SceneLightingUniform = { sunColor: vec3, sunDirection: vec3, skyColor: vec3 }` — defined once via `defineUniformStruct`, consumed by every lighting-aware shader.
3. **Shaders multiply by `sunColor`.** Each per-frame uniform upload pulls current values from `TimeOfDay`. Raw `sunColor` (no ambient floor) — iterate after visual check if night is too dark.
4. **Draw API: per-vertex `lightAffected` scalar.** Vertex format grows from 7 to 8 floats (32 bytes). Default is `1.0` (tinted); callers pass `ignoreLight: true` to get `0.0` (pass-through). The shape vertex shader multiplies color by `mix(vec3(1.0), sceneLighting.sunColor, lightAffected)`.
5. **No functional regression.** All existing `draw.*` callers continue to work; colors get multiplied by `sunColor` automatically. UI/debug opt out explicitly.

### Explicitly out of scope
- Sprite pipeline (`SpriteBatch`, `draw.image()`). None of the issue's targets use sprites.
- `BoatAirShader` (geometric pass with no visible color output).
- Ambient/moonlight floor — add only if night visibility is unworkable.
- Layer-based opt-out — `ignoreLight: true` per-call only, for this PR.

---

## Files to Modify

### 1. New shared lighting module
- **`src/game/time/TimeOfDay.ts`** — Port the four lighting functions from WGSL to TypeScript. Add `getSunAltitude()`, `getSunDirection(out?: V3d)`, `getSunColor(out?: V3d)`, `getSkyColor(out?: V3d)`. Cache three `V3d` instances (`_sunDirCache`, `_sunColorCache`, `_skyColorCache`) so the per-frame call is allocation-free. Behavior must match the current WGSL line-for-line (same magic numbers, same smoothsteps).
- **NEW: `src/game/time/SceneLightingUniform.ts`** — Defines the shared uniform struct via `defineUniformStruct("SceneLighting", { sunColor: vec3, sunDirection: vec3, skyColor: vec3 })` and exports both the struct definition and its WGSL text. One import for every lighting-aware shader.
- **NEW: helper for populating the uniform** — a small module-level `updateSceneLightingUniform(uniforms, timeOfDay)` that reads from `TimeOfDay` and writes the three vec3 fields. Every shader that uses this uniform calls it once per frame.

### 2. Shaders migrating from `time` to `SceneLightingUniform`
- **`src/game/world/shaders/scene-lighting.wgsl.ts`** — **DELETE** (after all consumers migrate).
- **`src/game/world/shaders/lighting.wgsl.ts`** (`fn_waterSurfaceLight`) — Replace `time: f32` parameter with `sceneLighting: SceneLighting`. Inside, use `sceneLighting.sunDirection`/`sunColor`/`skyColor` directly. Drop the `fn_SCENE_LIGHTING` dependency.
- **`src/game/world/shaders/terrain-rendering.wgsl.ts`** (`fn_renderTerrain`) — Replace `time: f32` parameter with `sceneLighting: SceneLighting`. Use `sceneLighting.sunDirection` for the diffuse term. **Add multiply by `sceneLighting.sunColor`** on the final color (currently only modulates direction, not color). Drop the `fn_SCENE_LIGHTING` dependency.
- **`src/game/surface-rendering/WaterFilterShader.ts`** — Replace `time` field in uniforms with `sceneLighting`. Update the single `getSkyColor(params.time)` call site (line 359) to `params.sceneLighting.skyColor`. Update the `waterSurfaceLight(...)` call to pass `params.sceneLighting`.
- **`src/game/surface-rendering/WaterFilterUniforms.ts`** — Swap `time: f32` for the `SceneLighting` struct field.
- **`src/game/surface-rendering/TerrainCompositeShader.ts`** — Same change: `params.time` → `params.sceneLighting` at the `renderTerrain` call.
- **`src/game/surface-rendering/TerrainCompositeUniforms.ts`** — Swap `time: f32` for `SceneLighting`.
- **`src/game/surface-rendering/WaterHeightUniforms.ts`** — `WaterHeightShader` currently receives `time` but the value feeds wave physics (phase), not lighting. **Keep `time` here** — the wave physics uses it for wave phase. This uniform does *not* need `SceneLighting`.
- **`src/game/surface-rendering/SurfaceRenderer.ts`** — Line 447 keeps `waterHeightUniforms.set.time(currentTime)`. Lines 471 and 507: remove `.set.time(currentTime)` for terrain/water-filter, replace with a call to `updateSceneLightingUniform(…, timeOfDay)` populated from the singleton fetched at line 640.
- **`src/game/boat/sail/SailShader.ts`** — Remove the inlined `getSunDirection` (lines 75–90). Add `sceneLighting: SceneLighting` to `SailUniforms`. Keep the existing `time` field for any future wind/animation use, OR drop it if unused elsewhere (verify by grep). Fragment shader at line 98 uses `uniforms.sceneLighting.sunDirection`. Also multiply `baseColor` by `sunColor` so the sail warms/darkens with the sun. Update the caller (`ClothRenderer` / `Sail`) to push the uniform.
- **`src/game/trees/TreeRasterizer.ts`** — Add `sceneLighting: SceneLighting` to both tree uniforms. Keep existing `time`/`timeOfDay` uniforms (they drive wind sway). Multiply per-fragment color by `sceneLighting.sunColor` before output. Update `TreeManager.ts:622` call site to push the new uniform.
- **`src/game/boat/RopeShader.ts`** — Add `sceneLighting: SceneLighting` to `RopeUniforms` (line ~100 area). Fragment shader line 250 (`return vec4<f32>(color, uniforms.alpha)`) becomes `return vec4<f32>(color * uniforms.sceneLighting.sunColor, uniforms.alpha)`. `draw(...)` method (line ~461) gains a `sceneLighting` parameter (or pulls from a caller-supplied `TimeOfDay`); upload alongside existing uniforms.

### 3. Draw API — extend vertex format with `lightAffected`
- **`src/core/graphics/tessellation/VertexSink.ts`** — Bump `VERTEX_STRIDE_FLOATS` from 7 to 8. Update `writeVertex` signature to accept a `lightAffected: number` parameter (after `a`, before `z`), writing to `view[o + 6]`, with `z` moving to `view[o + 7]`. Update the docstring.
- **`src/core/graphics/tessellation/color.ts`** — No change (unpacked color still 4 components).
- **`src/core/graphics/tessellation/circle.ts`** — `tessellateCircle` and `tessellateCircleFromTable` gain a `lightAffected: number` parameter; pass through to every `writeVertex` call.
- **Same mechanical change to all other tessellators** in `src/core/graphics/tessellation/`: `rectangle.ts` (2 functions), `line.ts`, `polyline.ts` (2 functions), `polygon.ts` (2 functions), `roundedPolygon.ts` (2 functions), `smoothPolygon.ts` (2 functions), `spline.ts`, `screenCircle.ts`.

### 4. Draw + MeshBuilder wiring
- **`src/core/graphics/Draw.ts`** — Add `ignoreLight?: boolean` to `DrawOptions`. In every primitive method (`fillRect`, `fillCircle`, `fillPolygon`, `fillTriangle`, `fillRoundedRect`, `fillRoundedPolygon`, `fillSmoothPolygon`, `strokeRect`, `strokeCircle`, `strokePolygon`, `strokeRoundedRect`, `strokeRoundedPolygon`, `strokeSmoothPolygon`, `spline`, `line`, `screenLine`, `screenPolyline`, `screenCircle`), compute `const lightAffected = opts?.ignoreLight ? 0 : 1;` and pass to the tessellator call. `image()` path is untouched (sprite pipeline out of scope).
- **`src/core/graphics/MeshBuilder.ts`** — Same addition of `ignoreLight` to every options object and forwarding through to the tessellator calls.

### 5. Draw API — buffer + shader wiring for the new vertex field
- **`src/core/graphics/webgpu/ShapeBatch.ts`** — No code change; `SHAPE_VERTEX_FLOATS` already derives from `VERTEX_STRIDE_FLOATS`. Allocation automatically grows to 32 bytes/vertex.
- **`src/core/graphics/CachedMesh.ts`**, **`src/core/graphics/DynamicMesh.ts`** — No code change; both derive from `VERTEX_STRIDE_FLOATS`.
- **`src/core/graphics/webgpu/WebGPURenderer.ts`**:
  - Update `shapeShaderSource` (line 63):
    - Add `@location(4) lightAffected: f32` to `VertexInput` struct.
    - Add a new uniform binding or extend the existing one for `sceneLighting: SceneLighting`. Simplest: extend the existing `Uniforms` struct (line 67) to include `sceneLighting: SceneLighting` (vec3 sunColor + vec3 sunDirection + vec3 skyColor). `sunDirection` and `skyColor` won't be used by this shader today but we keep the struct consistent across all lighting consumers.
    - In `vs_main`, after the existing `out.color = in.color * t.tint;`, multiply by `mix(vec3<f32>(1.0), uniforms.sceneLighting.sunColor, in.lightAffected)`. (Per-vertex is cheaper than per-fragment and the fragment shader is effectively a pass-through.)
  - Update the `geometryLayout` at line 475:
    - `arrayStride: SHAPE_VERTEX_FLOATS * 4` already scales (→ 32 bytes).
    - Add attribute `{ shaderLocation: 4, offset: 28, format: "float32" }` for `lightAffected`.
    - Move the `z` attribute from offset 24 to stay at offset 24 (unchanged — color is still at offset 8 through 23). Actually re-verify: position (8 bytes, offset 0), color (16 bytes, offset 8), lightAffected (4 bytes, offset 24), z (4 bytes, offset 28). **We put `lightAffected` before `z` to match the new `writeVertex` ordering**.
  - Update `shapeUniformBuffer` sizing (line 433) — grows by `SceneLightingUniform.byteSize`.
  - Update the `ViewUniforms` struct (line 187) to include the `SceneLighting` fields. Rename accordingly.
  - Add a per-frame uniform upload of current scene lighting. Candidate hook: inside `prepareShapeSink()` (WebGPURenderer.ts:1233) or in the existing per-frame uniforms upload path (line 1999 `uploadUniforms(...)`). The renderer needs a reference to the current `TimeOfDay`; either (a) add a setter `setSceneLighting(sunColor, sunDir, skyColor)` called from `SurfaceRenderer` each frame, or (b) make `WebGPURenderer` aware of the game → query `TimeOfDay` directly. **Preferred: (a)** — keeps the engine layer decoupled from game entities.
  - Update `submitTriangles` (line 1871) and `submitColoredTriangles` (line 1929) manual writes: bump from 7 floats/vertex to 8, writing `1.0` into slot 6 for both (world-space geometry always tinted) and moving z to slot 7.
- **`src/core/graphics/webgpu/SpriteBatch.ts`** — No change (sprite pipeline out of scope).

### 6. Opt-out for UI/debug call sites
- **`src/game/debug-renderer/modes/WaterHeightDebugMode.ts`** — lines 55, 76, 81: add `ignoreLight: true` to each options object.
- **`src/game/debug-renderer/modes/WindFieldDebugMode.ts`** — same.
- **`src/editor/ContourRenderer.ts`** — every `draw.*` call gets `ignoreLight: true`.
- **`src/boat-editor/BoatPreviewRenderer.ts`** — every `draw.*` call gets `ignoreLight: true`. (But the boat preview might want to *show* the lighting effect — flag for review.)
- **`src/rope-test/RopeTestController.ts`** — every `draw.*` call gets `ignoreLight: true`.
- Any `DebugRenderer.tsx` internals drawing reference geometry.

### 7. Hook SurfaceRenderer to push global lighting to WebGPURenderer
- **`src/game/surface-rendering/SurfaceRenderer.ts`** — In the existing onRender (near line 640 where `timeOfDay` is fetched), additionally call `this.game.renderer.setSceneLighting(sunColor, sunDir, skyColor)` using the cached V3d getters from `TimeOfDay`. This ensures the generic shape pipeline has current values before any `draw.*` calls this frame. Must happen **before** the HUD layer renders, but the shape pipeline uniform is uploaded at `flushShapes()` time — so calling `setSceneLighting` from any tick/render handler that runs before the first frame flush is sufficient.
- Confirm ordering: `SurfaceRenderer` is responsible for time-of-day visuals, so it's the natural owner even though the renderer uniform is engine-layer state. Alternative: add a tiny singleton entity that owns the uniform wiring. Not worth it for this PR.

---

## Execution Order

Steps are ordered so the codebase builds and runs cleanly after each one. Each step can be type-checked (`npm run tsgo`) before moving on.

### Phase A — Additive CPU port (no behavior change)
1. **Add lighting methods to `TimeOfDay`** (port WGSL math to TS). Cache three `V3d` instances on the entity for zero-alloc access. Compare outputs at a few hours (6am, noon, 6pm, midnight) against the WGSL — the shader still runs, so results should match.
2. **Create `src/game/time/SceneLightingUniform.ts`** — `defineUniformStruct` + WGSL module. Nothing imports it yet.

**State after Phase A**: everything still works, new APIs exist and are tested in isolation.

### Phase B — Migrate dedicated shaders from `time: f32` to `SceneLightingUniform`
One shader at a time, each keeps the codebase working:

3. **WaterFilterShader path**: update `lighting.wgsl.ts` (`fn_waterSurfaceLight` signature), `WaterFilterShader.ts`, `WaterFilterUniforms.ts`, `SurfaceRenderer.ts` (push `sceneLighting` instead of `time` for water-filter). `waterHeightUniforms` keeps its `time` field — wave physics, unrelated.
4. **TerrainComposite path**: update `terrain-rendering.wgsl.ts`, `TerrainCompositeShader.ts`, `TerrainCompositeUniforms.ts`, `SurfaceRenderer.ts`. **Also add the `* sunColor` multiply in `renderTerrain`** — this is where terrain gains day/night color tinting.
5. **SailShader**: remove inlined `getSunDirection`, add `SceneLighting` uniform, multiply `baseColor` by `sunColor`. Update `ClothRenderer.ts` (or wherever `SailShaderInstance.draw(...)` is called) to pass the current lighting.

**State after Phase B**: water + terrain + sails use shared uniform. `fn_SCENE_LIGHTING` still exists (Rope/Trees will need it removed in later step), but water/terrain/sails don't reference it.

### Phase C — Delete scene-lighting.wgsl.ts
6. Once steps 3–5 are done, **delete `src/game/world/shaders/scene-lighting.wgsl.ts`**. Confirm no imports remain (grep). Nothing else references WGSL-side lighting functions anymore.

### Phase D — Draw API vertex format bump
This is the risky step — touches the core vertex stride. Do all at once to keep the build green.

7. **Update `VertexSink.ts`**: bump stride to 8, update `writeVertex` signature.
8. **Update all 9 tessellator files** in parallel: each gets a new `lightAffected` parameter forwarded to `writeVertex`.
9. **Update `Draw.ts` + `MeshBuilder.ts`**: add `ignoreLight?: boolean` to options; derive `lightAffected` and pass to each tessellator.
10. **Update `WebGPURenderer.ts`**:
    - Shape shader source: new vertex attribute + multiply by `mix(vec3(1), sunColor, lightAffected)`.
    - Shape vertex buffer layout: new attribute at offset 28, z stays at offset 24 (reordering per `writeVertex` slots).
    - Uniform struct: add `SceneLighting` fields.
    - Uniform buffer size.
    - `submitTriangles` / `submitColoredTriangles` manual writes: bump to 8 floats, default `lightAffected = 1`.
    - Add `setSceneLighting(sunColor, sunDir, skyColor)` method.

**State after Phase D**: build + run. Every `draw.*` call is now multiplied by `sunColor`. `setSceneLighting` hasn't been called yet, so the uniform defaults to `(1,1,1)` — no visible difference.

### Phase E — Wire the shape uniform each frame
11. **`SurfaceRenderer.ts`**: in the same handler that pushes time to other shaders, also call `this.game.renderer.setSceneLighting(...)` using values pulled from `TimeOfDay`.

**State after Phase E**: world-space `draw.*` geometry (particles, buoy, anchor, etc.) now visibly tints with time of day. UI/debug are ALSO tinted — which breaks them until Phase F.

### Phase F — Opt out UI/debug call sites
12. Add `ignoreLight: true` to every `draw.*` call in:
    - `src/game/debug-renderer/modes/*.ts`
    - `src/editor/ContourRenderer.ts`
    - `src/boat-editor/BoatPreviewRenderer.ts`
    - `src/rope-test/RopeTestController.ts`
    - Any other debug-overlay file found via `grep -r "draw\." src/editor src/boat-editor src/rope-test src/game/debug-renderer`.

**State after Phase F**: UI/debug/editor stay at full brightness; world dims with time of day. Issue targets #1–#3 (particles, buoy, anchor) now lit.

### Phase G — Remaining dedicated shaders
These don't share the Draw API pipeline, so they need their own uniform additions.

13. **RopeShader**: add `sceneLighting` uniform; multiply final fragment color by `sunColor`. Update `RopeShaderInstance.draw(...)` signature + all callers.
14. **TreeRasterizer**: add `sceneLighting` uniform to both uniform structs used by the rasterizer; multiply per-fragment color by `sunColor`. Update `TreeManager.ts` call sites.

**State after Phase G**: feature complete. Every rendering system in the issue responds to time of day except sprites (explicitly out of scope) and BoatAirShader (geometric, no color output).

### Phase H — Validation
15. `npm run tsgo` — type check passes.
16. Manual test (user): run dev server, cycle time of day via the `Period` key (see `TimeOfDay.ts:65`), verify:
    - Particles (wind) warm/cool with sunlight.
    - Buoy and anchor change color with time.
    - Rope visibly darkens at night.
    - Trees darken at night.
    - UI HUDs (`StationHUD`, `NavigationHUD`, etc.) unchanged regardless of time — React/DOM, not affected.
    - Debug overlays (wind field, water height) stay pure.
    - At midnight, world should be noticeably dark but not black-void; if it's unusable, consider adding an ambient floor (separate follow-up).
17. `npm test` — E2E tests pass.
18. Profile check (`/profile-game`) — shape pipeline shouldn't regress; 28 → 32 bytes/vertex is a 14% vertex-data bandwidth bump but the stride is now 32 (naturally aligned), which on most GPUs is a wash or net-positive.

---

## Parallel opportunities

Within each phase, these are independent:

- **Phase B (steps 3–5)**: the three shader migrations touch disjoint files. Can be done in parallel.
- **Phase D (step 8)**: the 9 tessellator files are mechanical, identical changes. Can all be edited in parallel once `VertexSink.ts` is updated.
- **Phase F (step 12)**: each opt-out file is independent.
- **Phase G (steps 13–14)**: RopeShader and TreeRasterizer are independent.

Everything else is sequential (Phase A → B → C → D → E → F → G → H), because each phase depends on the prior one compiling.

---

## Risks and notes

- **Vertex stride change** is the load-bearing step. If I miss a `SHAPE_VERTEX_FLOATS` use site, the GPU will read misaligned data and render garbage. The grep in Phase D must be exhaustive — `src/core/graphics/webgpu/WebGPURenderer.ts` has three hand-rolled `i * SHAPE_VERTEX_FLOATS` loops (lines 1876, 1933, 1982) that all need bumping to 8.
- **Sail base color**: the cel-shader currently applies 3 tone steps (1.0 / 0.96 / 0.92) — multiplying by `sunColor` on top will make sails dimmer at day and near-black at night. May need to preserve some of the cel-shading's brightness floor by mixing rather than multiplying directly (e.g. `tone * mix(0.5, 1.0, lightAffected)`). Flag for visual review.
- **Terrain lighting change is visible**: step 4 adds `* sunColor` to terrain for the first time. Terrain is a lot of pixels — expect a noticeable visual change immediately when switching to dusk/night. Good place to verify the approach feels right before proceeding.
- **`TimeOfDay` availability**: the renderer's `setSceneLighting` call happens only when `SurfaceRenderer` is present. If there's a scene without SurfaceRenderer (editor? boat-editor?), the uniform stays at default `(1,1,1)` — everything full-brightness, which is the right failsafe.
- **No backward-compat shims**: the issue is one PR, the WGSL file gets deleted, the vertex stride changes. No need to keep both stride versions alive.
