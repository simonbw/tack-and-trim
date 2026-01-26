# Schema-Aware ComputeShader Bindings

## Goal

Enhance `ComputeShader` so that uniform bindings include their `UniformStructDef` schema. The shader base class will automatically inject WGSL struct definitions and binding declarations, eliminating manual `${Schema.wgsl}` insertions and duplicate binding declarations.

## Current State

### Files Involved

- `src/core/graphics/webgpu/ComputeShader.ts` - Base class for compute shaders
- `src/core/graphics/webgpu/ShaderBindings.ts` - Binding type definitions
- `src/core/graphics/UniformStruct.ts` - Type-safe uniform buffer system

### Current Compute Shaders

| Shader | Uniform Bindings | Schema Status |
|--------|------------------|---------------|
| `WindStateShader.ts` | `params` | Has `WindParams` schema, uses `${WindParams.wgsl}` |
| `AnalyticalWaterStateShader.ts` | `params`, `shadowData` | `params` has schema, `shadowData` is inline |
| `WetnessStateShader.ts` | `params` | No schema, inline `Params` struct |

### Current Pattern (WindStateShader)

```typescript
const bindings = {
  params: { type: "uniform" },  // No schema info
  outputTexture: { type: "storageTexture", format: "rg32float" },
} as const;

readonly code = /*wgsl*/ `
${WindParams.wgsl}  // Manual insertion

@group(0) @binding(0) var<uniform> params: Params;  // Manual declaration
@group(0) @binding(1) var outputTexture: texture_storage_2d<rg32float, write>;

@compute @workgroup_size(8, 8)
fn main(...) { ... }
`;
```

### Pain Points

1. **Multiple sources of truth** - Binding order in `bindings` object must match `@binding(N)` indices in WGSL
2. **Manual WGSL insertion** - Each shader manually inserts `${Schema.wgsl}`
3. **No type safety** - Can pass any buffer to `createBindGroup`, even if size/schema is wrong
4. **Redundant declarations** - Binding declarations written twice (TypeScript + WGSL)

## Desired Changes

### New Pattern

```typescript
const bindings = {
  params: { type: "uniform", schema: WindParams },  // Schema required
  outputTexture: { type: "storageTexture", format: "rg32float" },
} as const;

// Shader code starts with logic - no manual struct/binding declarations
readonly code = /*wgsl*/ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  // params.time, params.viewportLeft, etc. all available
  ...
}
`;
```

ComputeShader auto-generates and prepends:
```wgsl
struct Params {
  time: f32,
  viewportLeft: f32,
  ...
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rg32float, write>;
```

### Benefits

1. **Single source of truth** - Binding order defined once in `bindings` object
2. **Automatic WGSL generation** - Struct definitions and binding declarations generated from schemas
3. **Type safety** - Schema is required, enforced at compile time
4. **Less boilerplate** - Shader code is just the logic

## Files to Modify

### Core Infrastructure

- `src/core/graphics/webgpu/ShaderBindings.ts`
  - Add `schema` property to `UniformBinding` type (required, not optional)
  - Add `UniformStructDef` import
  - Add helper function `generateBindingDeclarations(bindings)` that produces WGSL binding lines
  - Add helper function `generateUniformStructs(bindings)` that collects and dedupes struct definitions

- `src/core/graphics/webgpu/ComputeShader.ts`
  - In `init()`, prepend auto-generated WGSL (structs + bindings) to `this.code` before creating shader module
  - Add new abstract property or method for the "body" code (the part after bindings)

### Shader Migrations

- `src/game/world-data/wind/webgpu/WindStateShader.ts`
  - Add `schema: WindParams` to params binding
  - Remove `${WindParams.wgsl}` from code
  - Remove manual `@group(0) @binding(N)` declarations

- `src/game/world-data/water/webgpu/AnalyticalWaterStateShader.ts`
  - Add `schema: AnalyticalWaterParams` to params binding
  - Create `ShadowDataParams` uniform struct for `shadowData` binding (currently inline)
  - Add `schema: ShadowDataParams` to shadowData binding
  - Remove `${AnalyticalWaterParams.wgsl}` from code
  - Remove manual binding declarations
  - Keep other inline structs that aren't uniforms (`WaveModification`, etc.)

- `src/game/surface-rendering/WetnessStateShader.ts`
  - Create `WetnessParams` uniform struct definition (extract from inline WGSL)
  - Add `schema: WetnessParams` to params binding
  - Remove inline `Params` struct from code
  - Remove manual binding declarations

### New Files to Create

- `src/game/surface-rendering/WetnessParams.ts` - Uniform struct for WetnessStateShader
- `src/game/wave-physics/ShadowDataParams.ts` - Uniform struct for shadow data (used by AnalyticalWaterStateShader)

## Execution Order

### Phase 1: Core Infrastructure (Sequential)

1. **ShaderBindings.ts** - Add schema to UniformBinding type, add WGSL generation helpers
2. **ComputeShader.ts** - Update init() to prepend generated WGSL

### Phase 2: Create Missing Schemas (Parallel)

These can be done in parallel:
- Create `WetnessParams.ts`
- Create `ShadowDataParams.ts`

### Phase 3: Migrate Shaders (Parallel)

These can be done in parallel after Phase 1 and 2:
- Migrate `WindStateShader.ts`
- Migrate `AnalyticalWaterStateShader.ts`
- Migrate `WetnessStateShader.ts`

## WGSL Generation Details

### Binding Declaration Generation

For each binding, generate the appropriate WGSL declaration:

| Binding Type | Generated WGSL |
|--------------|----------------|
| `{ type: "uniform", schema: X }` | `@group(0) @binding(N) var<uniform> {key}: {schema.name};` |
| `{ type: "storage" }` | `@group(0) @binding(N) var<storage, read> {key}: array<f32>;` |
| `{ type: "storageRW" }` | `@group(0) @binding(N) var<storage, read_write> {key}: array<f32>;` |
| `{ type: "storageTexture", format: F }` | `@group(0) @binding(N) var {key}: texture_storage_2d<{F}, write>;` |
| `{ type: "texture" }` | `@group(0) @binding(N) var {key}: texture_2d<f32>;` |
| `{ type: "sampler" }` | `@group(0) @binding(N) var {key}: sampler;` |

### Storage Buffer Typing

For storage buffers, we currently generate `array<f32>` which is generic. A future enhancement could add schemas to storage bindings too, but that's out of scope for this plan.

## Verification

1. Run `npm run tsgo` - TypeScript should pass
2. Run the game - Wind, water, and wetness should render correctly
3. Check browser console for WebGPU validation errors
