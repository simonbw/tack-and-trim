# Plans

This directory contains plans for larger code changes we'd like to make.

A plan should describe the current state of the codebase, how we'd like to make the change, and what we want the code to look like afterwards.
It should include files that we expect to change, and a description of if the work can be done in parallel per-file or not.
When creating a plan, you should clarify any open questions so that the plan is ready to be executed on.

## Index

- [`boat-editor.md`](boat-editor.md) — **Phase 1 done.** `src/boat-editor/`
  exists with the controller, document, camera, preview renderer, and
  UI. Phase 2 (physics debugger) status unknown — not visible in code.
- [`cached-geometry-abstraction.md`](cached-geometry-abstraction.md) —
  **Largely implemented.** `MeshBuilder.ts`, `CachedMesh.ts`,
  `DynamicMesh.ts`, and `VertexSink.ts` all exist; vertex stride was
  reworked to 7 floats and the per-instance transform path landed.
  `TiltDraw` is still a separate API surface, so the "dissolve TiltDraw"
  goal in the plan is not fully complete.
- [`flow-map-wind-gusts.md`](flow-map-wind-gusts.md) — **Phase 1 done**
  (`WIND_FLOW_CYCLE_PERIOD` and dual-layer flow-map implemented in
  `wind.wgsl.ts` and `WindConstants.ts`). Phase 2 (Rust pipeline
  computation of speedFactor / directionOffset / turbulence) and
  Phase 3 (multi-direction mesh) are still pending — wind mesh
  vertices ship at neutral values today.
- [`global-lighting-everywhere.md`](global-lighting-everywhere.md) —
  **Implemented.** `SceneLighting.ts` exists, the shape pipeline
  carries an `ignoreLight` per-vertex scalar through `Draw.ts` and
  `MeshBuilder.ts`, and consumer shaders read shared lighting
  uniforms. Worth re-reading before extending the system.
