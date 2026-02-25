# Wavefront Mesh: Remaining Work (Excluding Segment-Based Decimation)

## Scope
This plan captures remaining mesh-building work **other than** the planned shift to segment-based decimation.

Explicitly out of scope here:
- Decimation algorithm redesign from row-centric to segment-centric.

## Current State
Completed so far:
- Phase 1: Added mesh-building unit/invariant tests.
- Phase 2: Extracted marching kernels (`rayStepPhysics`, `wavefrontRefine`, `wavefrontPost`).
- Phase 3: Added contracts and explicit segment lifecycle typing.
- Phase 4: Centralized constants into `meshBuildConfig` with defaults.
- Phase 4b: Added `MESH_BUILD_*` env override resolution.
- Phase 5: Introduced `PhaseModel` to centralize phase/index bookkeeping.

## Desired Changes

### 1. Introduce Row Wrapper Types Across Pipeline
Move from bare `Wavefront = Segment[]` rows to explicit row objects carrying metadata.

Target direction:
- `MarchingRow { sourceStepIndex: number, segments: MarchingWavefront }`
- `OutputRow { sourceStepIndex: number, segments: OutputWavefront }`

Benefits:
- Makes phase/index metadata explicit on rows.
- Removes external mapping feel from `PhaseModel` for common paths.
- Clarifies stage boundaries in function signatures.

### 2. Collapse Transitional Compatibility Fields
Once row wrappers are in place:
- Remove deprecated `stepIndices` alias from decimation result.
- Prefer one canonical source-row metadata field.
- Keep compatibility shim only if needed for a short migration window.

### 3. Tighten Config Validation and Override Safety
Add validation for resolved mesh-build config values:
- Non-negative constraints where appropriate.
- Stability constraints (`post.maxDiffusionD <= 0.5`, etc.).
- Reasonable lower bounds for step/spacing to avoid accidental explosion.

Also improve logging:
- Include effective resolved config summary once per process.
- Keep env-override reporting concise and deterministic.

### 4. Add Memory/Perf Guardrails (Non-Behavioral)
Add lightweight instrumentation to catch regressions:
- Peak row/segment counts during marching.
- Vertex/index output size distribution.
- Optional heap snapshots only in debug/dev tooling (not runtime path).

### 5. Expand Tests Around Type/Metadata Contracts
Add tests that assert:
- Row metadata consistency through march -> skirts -> decimate -> mesh output.
- Phase offsets remain stable when rows are transformed.
- Config override validation errors are surfaced clearly.

### 6. Documentation Cleanup
Update internal docs to reflect final architecture after wrappers:
- Type flow by stage.
- Where phase metadata lives.
- How config/overrides are applied.

## Files to Modify

### Core mesh-building files
- `src/pipeline/mesh-building/marchingTypes.ts`
- `src/pipeline/mesh-building/marching.ts`
- `src/pipeline/mesh-building/decimation.ts`
- `src/pipeline/mesh-building/meshOutput.ts`
- `src/pipeline/mesh-building/phaseModel.ts` (likely reduced or removed once row metadata is explicit)
- `src/pipeline/mesh-building/meshBuildConfig.ts`
- `src/pipeline/mesh-building/wavefrontContracts.ts`

### Tests
- `src/pipeline/mesh-building/tests/decimation.test.ts`
- `src/pipeline/mesh-building/tests/meshOutput.test.ts`
- `src/pipeline/mesh-building/tests/marching.test.ts`
- New: config validation tests (suggested: `src/pipeline/mesh-building/tests/meshBuildConfig.test.ts`)

### Docs
- `src/pipeline/CLAUDE.md`
- Optional: add focused architecture note under `plans/` or `docs/` if needed.

## Execution Order

### Phase A: Row Wrapper Introduction (sequential)
1. Add wrapper types and adapter constructors.
2. Update marching output shape to emit row wrappers.
3. Update decimation and mesh output signatures to consume wrappers.
4. Keep temporary adapters for old shape only during migration.

### Phase B: Metadata/Phase Simplification (sequential)
1. Move phase source-step access to row metadata.
2. Reduce/remove `PhaseModel` where unnecessary.
3. Remove deprecated `stepIndices` alias once callsites are migrated.

### Phase C: Config Validation + Guardrails (parallelizable)
1. Add config validation utilities.
2. Add override validation tests.
3. Add optional instrumentation counters.

### Phase D: Docs + Final Cleanup (parallelizable)
1. Update CLAUDE/docs architecture notes.
2. Remove migration shims/adapters.
3. Final test + typecheck + benchmark pass.

## Parallelization Notes
- Phase A/B should be sequential to avoid broad type conflicts.
- Phase C test work and instrumentation can run in parallel once A/B interfaces stabilize.
- Documentation can be updated in parallel near the end.

## Open Questions
- Should `sourceStepIndex` be persisted on every row from march start, or recomputed in limited places?
- Should `PhaseModel` remain as a utility for advanced/custom phase policies, even if default path uses row metadata directly?
- What minimum/maximum clamps should we enforce for env overrides in production tooling?
