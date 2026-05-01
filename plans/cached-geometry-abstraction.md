# Cached Geometry Abstraction

> **Status (2026):** largely implemented — see `plans/README.md`. The
> `MeshBuilder` / `CachedMesh` / `DynamicMesh` / `VertexSink` types all
> exist and the per-instance transform path landed. The vertex stride
> referenced below has since been bumped from 7 to 8 floats (see
> `plans/global-lighting-everywhere.md` — the extra slot is the
> `lightAffected` flag). `TiltDraw` is still a separate API surface, so
> the "dissolve TiltDraw" goal is not fully complete. This document is
> preserved as the original execution plan; do not treat numeric strides
> below as authoritative.

Major engine refactor: introduce a first-class retained-mode mesh type that shares tessellation code with the existing immediate-mode `Draw` API, and move per-vertex transform baking to a per-instance storage-buffer model. Outcome: a fluent `MeshBuilder` that mirrors `Draw`, a `CachedMesh` whose submission is effectively `buffer.set(...)`, the dissolution of `TiltDraw` into the base API, and substantial CPU-bandwidth reduction even for immediate-mode frames.

## Current State

### Renderer (`src/core/graphics/webgpu/WebGPURenderer.ts`)
- Shape vertex stride: **19 floats** (76 bytes) = `position(2) + color(4) + modelCol0(2) + modelCol1(2) + modelCol2(2) + z(1) + zCoeffs(2) + zDepth(4)`.
- Sprite vertex stride: **21 floats** (`SHAPE` plus `texCoord(2)`).
- Of those 19/21 floats, **12 are transform state** (`modelCol0..2`, `zCoeffs`, `zDepth`) that's identical for every vertex inside a single `draw.at({...})` context — the renderer duplicates it per-vertex because the immediate-mode batch interleaves many `at()` contexts.
- `submitTriangles` / `submitTrianglesWithZ` / `submitColoredTriangles` walk the caller's `V2d[]`/`number[]` arrays, write 19 floats per vertex into the batch `Float32Array`, and push indices adjusted by `baseVertex`.
- `MAX_BATCH_VERTICES = 65535` (bounded by `Uint16Array` index buffer).
- Transform state (`currentTransform`, `currentZ`, `currentZCoeffX/Y`, `currentZRowX/Y/Z`) lives on the renderer and is set by `Draw.at()`/`save()`/`restore()`.
- Pipelines: `shape` + `sprite`, each in 4 depth-mode variants (`default`, `depth`, `alwaysWrite`, `noDepth`).
- Shaders compute `worldX = modelCol0·x + modelCol1·y + zCoeffs·z + modelCol2`; depth via `zDepth` per-vertex.

### Immediate-mode API (`src/core/graphics/Draw.ts`)
- `Draw` class (28 methods) wraps the renderer, handling transform stack, per-call tessellation, and submission.
- Tessellation is scattered across private helpers (`buildRoundedPolygonVertices`, `buildCatmullRomSpline`) and `Draw` methods. Each primitive produces `V2d[] + number[]` and calls `submitTriangles`.
- Pools exist for rect/line/triangle/circle vertex arrays (GC reduction), but tessellation re-runs every frame.
- `PathBuilder` (`src/core/graphics/PathBuilder.ts`) accumulates a point list and runs `fill()`/`stroke()` on demand.

### Tilt-aware API (`src/game/boat/TiltDraw.ts`)
- Thin wrapper on `WebGPURenderer` that takes a `TiltProjection` and exposes `mesh`, `line`, `polyline`, `circle` using the screen-width tessellators.
- `MeshContribution` interface (`{positions, indices, zValues, color, alpha}`) is the de-facto retained-mesh type today — used for `BoatRenderer.keelMesh`, `hullMesh`, `deckPlanMeshes`.

### Tessellators (`src/game/boat/tessellation.ts`)
- Pure functions that produce `MeshContribution`: `tessellateLineToQuad`, `tessellateScreenWidthLine`, `tessellateScreenWidthPolyline`, `tessellateRectToTris`, `tessellateRotatedRectToTris`, `tessellateCircleToTris`, `tessellateScreenCircle`, `tessellatePolylineToStrip`.
- Plus helpers: `roundCorners`, `subdivideSmooth`, `subdivideCatmullRom`, `tessellateRopeStrip` (rope has its own 5-float vertex pipeline, out of scope for this refactor).

### Consumers of TiltDraw (to migrate)
`src/game/boat/BoatRenderer.ts`, `src/game/port/Port.ts`, `src/game/boat/Anchor.ts`, `src/game/boat/sail/Sail.ts`, `src/game/boat/deck-plan.ts`.

### Pain points
1. Submission work is 12 per-vertex transform writes that are logically 12 per-`at()`-context writes.
2. No way to cache tessellated geometry at the `Draw` level — only the boat's ad-hoc `MeshContribution` path gets reuse, and only via `TiltDraw`.
3. `TiltDraw` conflates "screen-width tessellation needs a projection" with "I'm a separate API surface" — you can't submit a pre-tessellated boat mesh through plain `draw` without going through TiltDraw.
4. Re-tessellation every frame for static geometry: port docks (~50 primitives per port), editor contour splines (3× per contour), buoys (2 circles each), boat preview renderer.

---

## Desired Changes

### Target shape

1. **Per-instance transform via storage buffer.** Vertices carry only `position(2) + color(4) + z(1) = 7 floats` plus a separate `u16 transformIndex` stream. A per-frame `transforms` storage buffer holds one `Transform` struct per `draw.at` context / cached-mesh submission.
2. **Tint added to the transform struct.** 4 floats (`vec4<f32>`) per instance; shader does `finalColor = vertexColor * tint`. Fulfils user's upcoming tint requirements and covers dynamic-color cases without invalidating cached meshes.
3. **Shared tessellation via a sink.** A `VertexSink` interface that both `Draw` (writing into the renderer's live batch) and `MeshBuilder` (writing into a private `Float32Array`) implement. Every tessellator is a pure function over a `VertexSink`.
4. **`CachedMesh` submission ≈ memcpy.** `draw.mesh(m)` does: one `Float32Array.set` of geometry, one `TypedArray.fill` of the current transform index across the vertex range, one transform-buffer write (once per `draw.at`, amortised), plus an O(indices) integer-add loop for index rebase.
5. **`MeshBuilder` mirrors `Draw`.** Every non-transform method on `Draw` (`fillCircle`, `strokeRect`, `fillRoundedPolygon`, `fillSmoothPolygon`, `spline`, `path()`, `screenLine`, `screenCircle`, …) has the same signature on `MeshBuilder`, calling the same tessellator. The only `Draw`-exclusive methods are `at()`/`save()`/`restore()`/`image()`/`mesh()`.
6. **Screen-width primitives on both.** On `Draw` they pull the current tilt projection from renderer state. On `MeshBuilder` the caller passes a `TiltProjection` into the method at build time (the mesh is valid for that projection only; invalidation is the caller's problem).
7. **`TiltDraw` dissolved.** Its `.mesh()` moves to `draw.mesh()`; its screen-width `line`/`polyline`/`circle` become `draw.screenLine`/`draw.screenPolyline`/`draw.screenCircle` (and the same names on `MeshBuilder`, with `TiltProjection` parameter).
8. **Uint32 indices throughout.** Bigger batches (no more 65535-vertex cap), and mesh index data can be `buffer.set()`-copied verbatim with only an O(n) integer-add offset step.
9. **Indexed tessellation primitives are pure functions, not classes.** The tessellators (circle, polygon, rounded-polygon, smooth-polygon, Catmull-Rom, rope-style stroke with miter, screen-width line/polyline/circle) live in `src/core/graphics/tessellation/` and are imported by both `Draw` and `MeshBuilder`.

### Explicitly out of scope
- Rope rendering (5-float vertex pipeline, its own shader) — `src/game/boat/RopeShader.ts` and `tessellateRopeStrip` stay as-is for now.
- Surface/water/terrain WGSL compute pipelines — GPU-driven, not touched.
- Particle-system specialisation (instancing wind particles from a unit quad with per-instance radius/offset). Could come later as a second refactor phase; this plan keeps per-particle `fillCircle` working via the immediate-mode path.

### User-confirmed decisions
1. **Instance budget**: 4K transforms per frame; fail gracefully if exceeded (log + flush early, never crash).
2. **Tint**: included in the transform struct.
3. **Screen-width primitives**: first-class on both `Draw` and `MeshBuilder`; most powerful/performant option.
4. **Index width**: `Uint32Array` throughout.
5. **Scope**: single coordinated change, executed in a git worktree.

---

## New architecture details

### Transform storage buffer

```ts
// src/core/graphics/TransformBuffer.ts
// 16 floats per instance (64 bytes) for std430-friendly alignment:
//   modelCol0(2) + modelCol1(2) + modelCol2(2) + zCoeffs(2) + zDepth(4) + tint(4)
// Max 4096 instances per frame = 256 KB.

const MAX_INSTANCES_PER_FRAME = 4096;
const TRANSFORM_STRIDE_FLOATS = 16;

class TransformBuffer {
  private cpuBuffer: Float32Array;      // 4096 * 16 floats
  private gpuBuffer: GPUBuffer;          // storage, copy_dst
  private count: number;                 // slots used this frame
  private overflowWarned: boolean;

  reset(): void { this.count = 0; this.overflowWarned = false; }

  /** Returns instance index, or -1 on overflow (caller falls back to index 0). */
  alloc(t: Transform): number { ... }

  upload(device: GPUDevice): void { /* writeBuffer up to count */ }
}
```

Overflow behaviour: when `count >= MAX_INSTANCES_PER_FRAME`, log a single warning per frame and return index 0 (which is guaranteed to be the "identity root" transform written at frame start). Subsequent draws render in root space — visually wrong but non-crashing.

### Shape vertex layout (new)

Two vertex buffers bound to the pipeline:

```
Buffer A (stepMode: "vertex", stride 28 bytes):
  @location(0) position: vec2<f32>   // local-space
  @location(1) color:    vec4<f32>   // per-vertex
  @location(2) z:        f32         // local z

Buffer B (stepMode: "vertex", stride 4 bytes):
  @location(3) transformIndex: u32   // index into transforms storage buffer
```

Storage buffer binding:
```
@group(0) @binding(1) var<storage, read> transforms: array<Transform>;
```

Vertex shader becomes:
```wgsl
let t = transforms[in.transformIndex];
let worldX = t.modelCol0.x * in.position.x + t.modelCol1.x * in.position.y
             + t.zCoeffs.x * in.z + t.modelCol2.x;
// ... same for Y, depth
out.color = in.color * t.tint;
```

**Sprite vertex buffer** gets the parallel treatment: `position(2) + texCoord(2) + color(4) + z(1) = 9 floats = 36 bytes`, plus `transformIndex(u32)` on the second stream.

**Memory savings**: 76→32 bytes/vertex (shape) and 84→40 bytes/vertex (sprite) — ~58% reduction in GPU vertex bandwidth.

### Batch structure (new)

```ts
// src/core/graphics/webgpu/ShapeBatch.ts
class ShapeBatch {
  vertexData:   Float32Array;   // MAX_BATCH_VERTICES * 7
  indexData:    Uint32Array;    // MAX_BATCH_INDICES
  txIndexData:  Uint32Array;    // MAX_BATCH_VERTICES, one per vertex
  vertexCount:  number;
  indexCount:   number;

  // VertexSink impl
  reserveVertices(n: number): { base: number; view: Float32Array };
  reserveIndices(n: number):  Uint32Array;  // returns writable slice, caller adds `base`
  stampTransformIndex(range: { start: number; count: number }, idx: number): void;
}
```

MAX_BATCH_VERTICES raised to e.g. 262_144 (1 MiB vertex data per batch, 1 MiB transform-index data). Flush still happens on state/transform-buffer-full/batch-full.

### VertexSink interface

```ts
// src/core/graphics/tessellation/VertexSink.ts
export interface VertexSink {
  /** Reserve n contiguous vertices, return base index and writable 7-float-stride view. */
  reserveVertices(n: number): { base: number; view: Float32Array };
  /** Reserve n indices; caller fills the returned slice with values in [0, n_verts_in_this_primitive). */
  reserveIndices(n: number): Uint32Array;
}

// Helper for writing one vertex's 7 floats:
export function writeVertex(
  view: Float32Array, i: number,
  x: number, y: number, r: number, g: number, b: number, a: number, z: number,
): void {
  const o = i * 7;
  view[o] = x; view[o+1] = y;
  view[o+2] = r; view[o+3] = g; view[o+4] = b; view[o+5] = a;
  view[o+6] = z;
}
```

The shape batch implements `VertexSink` by carving slices off its live `Float32Array`/`Uint32Array`. A `MeshBuilder` implements it by growing its private typed arrays (`ArrayBuffer.transfer` or copy-grow).

### Tessellators (shared)

```
src/core/graphics/tessellation/
  VertexSink.ts
  circle.ts          — tessellateCircle(sink, cx, cy, z, r, segments, color, alpha)
  rectangle.ts       — tessellateRect, tessellateRotatedRect
  polygon.ts         — tessellateFillPolygon (ear-clip), tessellateStrokePolygon (miter)
  roundedPolygon.ts  — Bézier-corner builder + fill + stroke
  smoothPolygon.ts   — Catmull-Rom builder + fill + stroke
  spline.ts          — open Catmull-Rom
  line.ts            — tessellateLine (world-width), tessellateScreenLine (tilt-width)
  polyline.ts        — world-width strip + screen-width strip (miter + round joins)
  screenCircle.ts    — tilt-aware circle
  path.ts            — PathBuilder's fill/stroke rendered via sink
```

Each function takes a `VertexSink`, a color (or color resolver for gradients), an alpha, a z, and primitive-specific parameters. Nothing else.

Tint is **not** baked here — tint is per-instance, applied in shader.

### CachedMesh type

```ts
// src/core/graphics/CachedMesh.ts
export class CachedMesh {
  constructor(
    readonly vertexData: Float32Array,   // packed 7-float vertices
    readonly indexData:  Uint32Array,
    readonly vertexCount: number,
    readonly indexCount:  number,
  ) {}

  /** Byte size estimate, for budgeting. */
  get byteSize(): number {
    return this.vertexCount * 28 + this.indexCount * 4;
  }

  /** Disposable; no GPU resources held. Frees buffers when dropped. */
}
```

Immutable by construction. For parametric-dynamic meshes (see `DynamicMesh` below) we use a separate type.

### MeshBuilder

```ts
// src/core/graphics/MeshBuilder.ts
export class MeshBuilder implements VertexSink {
  private vertices: Float32Array;  // growable
  private indices:  Uint32Array;
  private vertexCount = 0;
  private indexCount  = 0;

  // Mirror Draw's primitive API — each method calls a shared tessellator.
  fillCircle(x, y, r, opts?: CircleOptions & { z?: number }): this { ... }
  fillRect(...): this;
  fillTriangle(...): this;
  fillPolygon(...): this;
  strokePolygon(...): this;
  line(...): this;
  fillRoundedRect(...): this;
  fillRoundedPolygon(...): this;
  strokeRoundedPolygon(...): this;
  fillSmoothPolygon(...): this;
  strokeSmoothPolygon(...): this;
  spline(...): this;

  // Screen-width variants — caller passes TiltProjection:
  screenLine(x1,y1,z1, x2,y2,z2, width, tilt, opts?): this;
  screenPolyline(points, zs, width, tilt, opts?): this;
  screenCircle(x, y, z, r, segments, tilt, opts?): this;

  // Paths:
  path(): PathBuilder;   // PathBuilder also sink-based, finalises into this builder

  // VertexSink impl:
  reserveVertices(n): { base, view };
  reserveIndices(n): Uint32Array;

  build(): CachedMesh;   // trims buffers to size, returns immutable mesh
  reset(): void;         // reuse builder for pooling
}
```

### DynamicMesh (parametric-dynamic)

For cases like cloth sail surfaces where topology is stable but per-vertex data changes each frame:

```ts
// src/core/graphics/DynamicMesh.ts
export class DynamicMesh {
  constructor(readonly vertexCapacity: number, readonly indexCapacity: number);
  readonly vertexData: Float32Array;  // exposed for direct write
  readonly indexData:  Uint32Array;
  vertexCount: number;
  indexCount:  number;
}
```

`draw.mesh()` accepts `CachedMesh | DynamicMesh`. Submission is identical — the immutability is a caller contract, not a runtime distinction.

### Draw API changes

```ts
class Draw {
  // Existing transform/primitive API, unchanged surface (implementations rewritten to use sinks).

  // New:
  mesh(m: CachedMesh | DynamicMesh): void;

  // Renamed / promoted from TiltDraw:
  screenLine(x1,y1,z1, x2,y2,z2, width, opts?): void;      // pulls tilt from renderer state
  screenPolyline(points, zs, width, opts?): void;
  screenCircle(x, y, z, radius, segments, opts?): void;
}
```

Internally: `Draw.at()` writes a new transform into the current frame's `TransformBuffer`, stores the returned index as `currentTransformIndex`; every subsequent `reserveVertices` on the batch sink gets its `transformIndex` stamped by `stampTransformIndex`.

### Screen-width primitives — tilt source

- `Draw.screenLine` etc.: read the current `TiltProjection` from renderer state. Added to the transform context by `draw.at({ tilt })` (existing API — internally it now also precomputes a `TiltProjection` and stashes it alongside the transform).
- `MeshBuilder.screenLine` etc.: caller passes `TiltProjection` as a parameter. Caller is responsible for rebuilding the mesh when the projection invalidates (roll/pitch/yaw change). Recommendation for boat rigging: rebuild at most N times per second when tilt deltas exceed a threshold — or, simpler, rebuild each frame and still win on avoiding polygon/spline tessellation for non-screen-width content.

### TiltProjection on the renderer

`computeTiltProjection` moves from `src/game/boat/tessellation.ts` to `src/core/graphics/TiltProjection.ts`. `Draw.at({ tilt })` computes and caches it on the renderer frame state. `Draw.screenLine` / `MeshBuilder.screenLine` consume it.

### Failure graceful-degradation

- Transform buffer overflow: log once per frame, `alloc` returns 0, visible misrender in rare cases.
- Batch full during `draw.mesh(m)` where `m.vertexCount > MAX_BATCH_VERTICES`: log warning, skip the mesh. A mesh that big should use its own direct draw call — out of scope for v1.
- Batch full during normal submission: flush + retry, as today.

---

## Files to Modify

### New files

- `src/core/graphics/tessellation/VertexSink.ts` — `VertexSink` interface + `writeVertex` helper.
- `src/core/graphics/tessellation/circle.ts` — world-space filled circle.
- `src/core/graphics/tessellation/rectangle.ts` — axis-aligned + rotated rect.
- `src/core/graphics/tessellation/polygon.ts` — fill (ear-clip) + stroke (miter joins).
- `src/core/graphics/tessellation/roundedPolygon.ts` — Bézier-corner builder + fill + stroke.
- `src/core/graphics/tessellation/smoothPolygon.ts` — Catmull-Rom closed builder + fill + stroke.
- `src/core/graphics/tessellation/spline.ts` — open Catmull-Rom stroke.
- `src/core/graphics/tessellation/line.ts` — world-width line + screen-width line (tilt-aware).
- `src/core/graphics/tessellation/polyline.ts` — world-width + screen-width polylines with miter/round joins.
- `src/core/graphics/tessellation/screenCircle.ts` — tilt-aware circle.
- `src/core/graphics/tessellation/path.ts` — PathBuilder's fill/stroke over a sink.
- `src/core/graphics/TiltProjection.ts` — moved from `game/boat/tessellation.ts`: `TiltProjection` interface + `computeTiltProjection`.
- `src/core/graphics/TransformBuffer.ts` — per-frame CPU+GPU transform storage, with tint slot.
- `src/core/graphics/CachedMesh.ts` — immutable retained mesh.
- `src/core/graphics/DynamicMesh.ts` — mutable mesh with fixed capacity.
- `src/core/graphics/MeshBuilder.ts` — builder with Draw-mirroring API.
- `src/core/graphics/webgpu/ShapeBatch.ts` — extracted batch state implementing `VertexSink`.
- `src/core/graphics/webgpu/SpriteBatch.ts` — sprite equivalent.

### Significantly modified files

- `src/core/graphics/webgpu/WebGPURenderer.ts`
  - New shape + sprite WGSL (reads transform from storage buffer via `transformIndex`).
  - Two-stream vertex buffer layout; new pipeline definitions; bind group adds storage-buffer binding.
  - Batch state moved to `ShapeBatch`/`SpriteBatch` classes.
  - New per-frame `TransformBuffer` reset at `beginFrame`, uploaded before each flush.
  - `submitTriangles`/`submitTrianglesWithZ`/`submitColoredTriangles` rewritten to write into the new format and stamp `transformIndex`.
  - `drawImage` rewritten for the new sprite format.
  - Transform-state helpers (`setTransform`, `translate`, `rotate`, `setZ`, `setZCoeffs`, `setZRow`, `save`, `restore`) rewritten to update a *single* `pendingTransform` and allocate a new storage-buffer slot lazily (on next submit after a state change).
  - Indices are `Uint32Array`; `MAX_BATCH_VERTICES` raised.
  - New method: `drawMesh(m: CachedMesh | DynamicMesh)` — the hot path.

- `src/core/graphics/Draw.ts`
  - Every primitive method rewritten to call a shared tessellator over `this.renderer.currentShapeSink` (or equivalent).
  - `at()` accepts optional `tilt` — computes `TiltProjection`, stores on renderer for `screenLine` etc. (existing behaviour factored cleanly).
  - New methods: `mesh()`, `screenLine()`, `screenPolyline()`, `screenCircle()`.
  - Remove per-primitive pooling arrays (`_rectVertices`, etc.) — tessellators write directly into the sink.

- `src/core/graphics/PathBuilder.ts`
  - Rewritten to accumulate points and emit into a `VertexSink` on `fill()`/`stroke()` via the new `tessellation/path.ts` helpers.
  - Constructor now takes a `VertexSink` *or* accepts one at the call site; immediate-mode path-builders grab the renderer's current sink.

### Deleted / replaced files

- `src/game/boat/TiltDraw.ts` — **deleted.** Its `mesh()` becomes `draw.mesh()`; `line`/`polyline`/`circle` become `draw.screenLine`/`draw.screenPolyline`/`draw.screenCircle`.
- `src/game/boat/tessellation.ts` — **split**:
  - `TiltProjection` + `computeTiltProjection` → `src/core/graphics/TiltProjection.ts`.
  - `tessellateScreenWidthLine`, `tessellateScreenWidthPolyline`, `tessellateScreenCircle`, `tessellateLineToQuad`, `tessellateCircleToTris`, `tessellatePolylineToStrip`, `tessellateRectToTris`, `tessellateRotatedRectToTris` → corresponding files in `src/core/graphics/tessellation/`, rewritten against `VertexSink`.
  - `MeshContribution` → **deleted**; replaced by `CachedMesh`.
  - `roundCorners`, `subdivideSmooth`, `subdivideCatmullRom` → moved to `src/core/graphics/tessellation/curves.ts` (still pure geometry helpers, reused by new tessellators).
  - `tessellateRopeStrip`, `CameraTransform2x2`, `extractCameraTransform`, `ROPE_VERTEX_FLOATS`, `RopeMeshData` → stay (rope pipeline untouched); move to `src/game/boat/rope-tessellation.ts` for clarity.

### Consumer migration (TiltDraw callers)

- `src/game/boat/BoatRenderer.ts`
  - Replace `const td = new TiltDraw(renderer, tilt)` with `draw.at({ pos, angle, tilt: { roll, pitch, zOffset } }, () => { ... })`.
  - `td.mesh(this.keelMesh)` → `draw.mesh(this.keelMesh)` — **but `keelMesh`/`hullMesh`/`deckPlanMeshes` need to become `CachedMesh` instead of `MeshContribution`.** Rewrite the constructor's `buildStaticMeshes()` to use `MeshBuilder`.
  - `td.line(...)` → `draw.screenLine(...)`.
  - `td.polyline(...)` → `draw.screenPolyline(...)`.
  - `td.circle(...)` → `draw.screenCircle(...)`.

- `src/game/port/Port.ts`
  - Same renames. **Additionally**: build a `CachedMesh` per port at construction containing pilings + cleats + deck boards + stringers. In `onRender`, a single `draw.mesh(this.dockMesh)` replaces the inner loops. Because pilings use `screenCircle` and cleats/boards are tilt-aware, mesh is built against the *port's* tilt (zero roll/pitch for a stationary dock — no invalidation needed).

- `src/game/boat/Anchor.ts`
  - TiltDraw rename. Anchor geometry is dynamic (depends on body orientation each frame) so stays immediate-mode.

- `src/game/boat/sail/Sail.ts`
  - TiltDraw rename. Furled-sail quad can become a `CachedMesh` (fixed 4 verts, reused); deployed cloth sail is a `DynamicMesh` whose per-vertex data is updated from the cloth sim each frame.

- `src/game/boat/deck-plan.ts`
  - `MeshContribution` → `CachedMesh`. Deck-plan tessellation moves from returning a raw `MeshContribution` to using `MeshBuilder` and returning a `CachedMesh`.

### Consumer migration (pure Draw callers with big wins)

- `src/editor/ContourRenderer.ts`
  - Cache `CachedMesh` per contour for shadow/glow/main strokes + fill. Invalidate on control-point or tension change. `onRender` becomes 3–4 `draw.mesh(...)` calls per contour instead of 3× spline+stroke re-tessellation.

- `src/boat-editor/BoatPreviewRenderer.ts`
  - Rebuild cached hull/keel/rudder/rig meshes only on config change; reuse across preview frames.

- `src/game/Buoy.ts`
  - Shared `CachedMesh` in a module-level constant (buoys have identical geometry); each buoy `draw.at({ pos, angle })` + `draw.mesh(BUOY_MESH)`.

- `src/game/WindParticles.ts`
  - Stays immediate-mode. Radius varies per frame, so no caching win; benefits from the per-vertex transform cost going away.

### Not migrated (explicitly)
- `src/core/util/stats-overlay/StatsOverlay.tsx` — React-based HUD, no draw API calls.
- Surface/water/terrain renderers — separate GPU pipelines.
- Rope rendering — separate shader/format.
- Debug renderer modes — low traffic, keep immediate-mode.

---

## Execution Order

All work happens in a git worktree off `main`:

```
git worktree add ../tack-and-trim-cached-geom -b cached-geometry
cd ../tack-and-trim-cached-geom
```

Work proceeds in six phases. Earlier phases gate later phases; within a phase, files listed under "parallel" can be done independently.

### Phase 0 — Baseline profile

Capture a profiling baseline *before* any changes. Run the dev server in the worktree, then:

```
npm run profile-game -- --json --duration 10 --warmup 2 > baseline.json
jq '[.[] | select(.shortLabel | test("render|tessellat|submit|draw|flush|batch|matrix"; "i"))]' baseline.json > baseline.rendering.json
```

Keep `baseline.rendering.json` committed (or stashed) for after-the-fact diff.

### Phase 1 — Shared scaffolding

Sequential — these are dependencies for everything that follows.

1. `src/core/graphics/TiltProjection.ts` (move from `game/boat/tessellation.ts`, no behaviour change).
2. `src/core/graphics/tessellation/VertexSink.ts` + `writeVertex` helper.
3. `src/core/graphics/TransformBuffer.ts` (CPU side only; GPU binding comes in Phase 3).
4. `src/core/graphics/CachedMesh.ts`, `src/core/graphics/DynamicMesh.ts`.
5. `src/core/graphics/tessellation/curves.ts` — migrate `roundCorners`, `subdivideSmooth`, `subdivideCatmullRom` (pure helpers, no sink).

### Phase 2 — Tessellators

Parallel (each file independent, each implements one primitive against `VertexSink`):
- `tessellation/circle.ts`
- `tessellation/rectangle.ts`
- `tessellation/polygon.ts`
- `tessellation/roundedPolygon.ts`
- `tessellation/smoothPolygon.ts`
- `tessellation/spline.ts`
- `tessellation/line.ts`
- `tessellation/polyline.ts`
- `tessellation/screenCircle.ts`
- `tessellation/path.ts`

Each file ports logic from `Draw.ts` / `tessellation.ts` and writes via `VertexSink` + `writeVertex`. Unit-level sanity: each exports a pure function taking `VertexSink` + primitive params.

### Phase 3 — Renderer refactor

Sequential within this phase.

1. Extract `ShapeBatch` + `SpriteBatch` classes from `WebGPURenderer` (still using old vertex format, no behaviour change — purely a code move to make the next step tractable).
2. Write new shape + sprite WGSL with `transformIndex` + storage-buffer binding + tint. Add to `WebGPURenderer` alongside old shaders; gate on an internal feature flag so you can A/B quickly during development.
3. Rewrite `ShapeBatch` / `SpriteBatch` to use the new vertex format (7 / 9 floats) + separate `transformIndex` stream + `Uint32Array` indices. Update pipeline definitions.
4. Integrate `TransformBuffer` into `WebGPURenderer`: allocate + reset at `beginFrame`, upload before each flush, bind as storage buffer.
5. Rewrite transform-state methods (`setTransform`, `translate`, `rotate`, `save`, `restore`, `setZ`, `setZCoeffs`, `setZRow`) to update a single `pendingTransform` object; allocate a `currentTransformIndex` lazily on the next submit after any state mutation.
6. Rewrite `submitTriangles` / `submitTrianglesWithZ` / `submitColoredTriangles` / `drawImage` to write the new format and stamp `transformIndex`.
7. Add `drawMesh(m: CachedMesh | DynamicMesh)` — the memcpy hot path.
8. Drop old shaders + format. Remove feature flag. Raise `MAX_BATCH_VERTICES`.

### Phase 4 — API surface

Sequential.

1. Rewrite `Draw.ts` methods against tessellators. Remove internal pooling arrays. Wire `at({ tilt })` to compute + cache `TiltProjection` on the renderer frame state.
2. Add `Draw.mesh()`, `Draw.screenLine()`, `Draw.screenPolyline()`, `Draw.screenCircle()`.
3. Rewrite `PathBuilder.ts` to use sink-based tessellation.
4. Create `MeshBuilder.ts` mirroring `Draw`'s primitive surface (calls same tessellators).

### Phase 5 — Consumer migration

Mostly parallel — each consumer is independent once Phase 4 is complete. Can be done in any order. Delete `TiltDraw.ts` and the old parts of `game/boat/tessellation.ts` **last**, once all callers are migrated.

Parallel:
- `src/game/port/Port.ts` — TiltDraw rename + build `CachedMesh` for dock geometry in constructor.
- `src/game/boat/BoatRenderer.ts` — TiltDraw rename + convert `keelMesh`/`hullMesh`/`deckPlanMeshes` to `CachedMesh` via `MeshBuilder`.
- `src/game/boat/Anchor.ts` — TiltDraw rename only.
- `src/game/boat/sail/Sail.ts` — TiltDraw rename; furled quad → `CachedMesh`; deployed cloth → `DynamicMesh`.
- `src/game/boat/deck-plan.ts` — return `CachedMesh` from build function.
- `src/editor/ContourRenderer.ts` — per-contour cached strokes + fill, invalidate on control-point/tension change.
- `src/boat-editor/BoatPreviewRenderer.ts` — cache hull/keel/rudder/rig meshes; rebuild on config change.
- `src/game/Buoy.ts` — module-level shared `CachedMesh`.

Sequential after the above:
1. Delete `src/game/boat/TiltDraw.ts`.
2. Remove `MeshContribution` + screen-width tessellators from `src/game/boat/tessellation.ts` (what remains is rope tessellation, which moves to `rope-tessellation.ts`).

### Phase 6 — Verification + profile diff

1. `npm run tsgo` — zero type errors.
2. `npm run prettier` — format clean.
3. `npm test` — E2E tests pass.
4. Launch dev server; smoke-test main game, editor, and boat-editor routes. Watch for transform-buffer-overflow warnings (should see none in normal gameplay).
5. Re-profile:

   ```
   npm run profile-game -- --json --duration 10 --warmup 2 > after.json
   jq '[.[] | select(.shortLabel | test("render|tessellat|submit|draw|flush|batch|matrix"; "i"))]' after.json > after.rendering.json
   ```

   Compare `baseline.rendering.json` to `after.rendering.json`. Expected outcomes (order of magnitude):
   - `submit*` ms/frame: ≥30% reduction (no more per-vertex matrix bake).
   - `tessellat*` / `render` ms/frame: significant drop from cached meshes (port, contour, buoy).
   - Total `render` ms/frame down, `frame` ms/frame down.

6. If any metric regresses, investigate before merging. The transform-buffer upload is one candidate — size it against what the profile shows.

7. Once happy: open a PR from the worktree branch to `main`.

---

## Profiling workflow reference

The `profile-game.ts` CLI already supports `--json` (dumps the full profiler stats array) and runs Chrome headless with WebGPU. Filtering to rendering-only sections with `jq`:

```
# Everything in the render pipeline
jq '[.[] | select(.shortLabel | test("render|tessellat|submit|draw|flush|batch|matrix|mesh"; "i"))]'

# Just the top-level frame/render/tick rollup
jq '[.[] | select(.depth == 0 or (.shortLabel | test("^(frame|render|tick|physics)$")))]'

# ms/frame descending (find the heavy hitters)
jq 'sort_by(-.msPerFrame) | .[0:20]'

# Compare two runs side by side
paste <(jq -r '.[] | "\(.shortLabel)\t\(.msPerFrame)"' baseline.rendering.json) \
      <(jq -r '.[] | "\(.shortLabel)\t\(.msPerFrame)"' after.rendering.json) \
  | column -t
```

Add profiler sections as needed during Phase 3/4 development if the existing ones don't isolate the work (e.g. `transformBuffer.alloc`, `mesh.submit`, `batch.stampTransformIndex`). Use `profiler.count("...")` for cheap call-count checks that don't add measurement overhead.

---

## Risks and mitigations

- **Shader regression on depth handling.** Depth mapping is subtle (`DEPTH_Z_MIN`..`DEPTH_Z_MAX`, per-vertex zDepth). Mitigation: preserve the exact same math, just move the zDepth inputs from per-vertex attributes into the per-instance transform struct. A/B test against the old shader during Phase 3 via feature flag.
- **Transform buffer overflow on hot frames.** 4K instances is generous but not unbounded. Mitigation: count-tracking with `profiler.count("transformBuffer.alloc")` in dev, log warnings on overflow, verify with profile runs on `Anvil` and `San Juan` levels (both have dense geometry).
- **Mesh invalidation bugs.** Especially `ContourRenderer` — forgetting to invalidate on control-point drag → stale mesh. Mitigation: explicit `invalidate()` calls in the command-pattern mutator paths.
- **Sprite-pipeline drift.** Sprites are a parallel refactor; easy to forget a pipeline variant. Mitigation: run the smoke test through each of the four depth-mode pipeline variants (main pass, editor pass, offscreen pass).
- **`Uint32Array` → `Uint16Array` tex atlas paths.** Double-check that tex atlas / tile rendering code isn't affected — it shouldn't be, as it goes through `submitTriangles` too and will just see a wider index stream.

---

## Non-goals for this plan

- Particle-specific instancing (render 500 wind particles as 500 instances of a unit quad with per-instance position + radius). Worth doing later; kept out to limit scope.
- GPU-resident mesh buffers (skip the CPU → GPU copy entirely for truly static meshes). Possible future follow-up once the CPU-side abstraction is solid.
- Switching rope rendering into the unified format. Rope has its own shader with UV-based procedural shading; merging it is a separate project.
- Changing the 4-variant depth pipeline model. Keep as-is for now.
