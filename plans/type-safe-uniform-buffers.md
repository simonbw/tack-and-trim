# Type-Safe Uniform Buffer System

## Current State

The codebase uses numeric array indexing to set uniform buffer values, which is error-prone:

```typescript
// From SurfaceRenderer.ts
this.uniformData[23] = this.waterTexWidth;
this.uniformData[24] = this.waterTexHeight;
```

This pattern appears in **6 files** with varying approaches:

| File | Buffer Size | Pattern | Risk Level |
|------|-------------|---------|------------|
| `SurfaceRenderer.ts` | 144 bytes (36 floats) | Direct `uniformData[index]` | High - 36 indices to track |
| `DebugShaderManager.ts` | 48 bytes (12 floats) | Direct index + Int32Array overlay | Medium |
| `WebGPURenderer.ts` | 48 bytes (12 floats) | Direct index for mat3x3 | Low - simple layout |
| `TerrainComputeBuffers.ts` | 48 bytes | DataView with byte offsets | Medium |
| `WaterComputeBuffers.ts` | 144 bytes | Float32Array/Uint32Array index | High - complex layout |
| `WindTileCompute.ts` | 64 bytes (16 floats) | Array literal initialization | Low - all-at-once |

Each TypeScript file has a corresponding WGSL struct that must match exactly:
- `SurfaceShader.ts:34-61` - `struct Uniforms`
- `DebugShaderManager.ts:62-70` - `struct Uniforms`
- `WebGPURenderer.ts:20-22` - `struct Uniforms`
- `TerrainStateShader.ts:29-40` - `struct Params`
- `AnalyticalWaterStateShader.ts:89-108` - `struct Params`
- `WindStateShader.ts:43-64` - `struct Params`

## Desired Changes

Create a unified system where:

1. **Single source of truth** - Define uniform layout once in TypeScript
2. **Type-safe setters** - Generated methods like `uniforms.set.time(1.5)`
3. **WGSL generation** - `uniforms.wgsl` produces the matching shader struct
4. **Automatic alignment** - Handles WebGPU's 16-byte alignment rules for mat3x3, vec3, etc.

### Target API

```typescript
import { defineUniformStruct, f32, i32, vec2, vec4, mat3x3 } from '../core/graphics/UniformStruct';

const SurfaceUniforms = defineUniformStruct('Uniforms', {
  cameraMatrix: mat3x3,
  time: f32,
  renderMode: i32,
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  // ...
});

// In shader code
const fragmentCode = `
${SurfaceUniforms.wgsl}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@fragment
fn main() -> @location(0) vec4<f32> {
  let t = uniforms.time;  // Field names match
}
`;

// In TypeScript
const uniforms = SurfaceUniforms.create();
uniforms.set.time(1.5);
uniforms.set.cameraMatrix(matrix);
device.queue.writeBuffer(gpuBuffer, 0, uniforms.buffer);
```

## Files to Modify

### New Files

- `src/core/graphics/UniformStruct.ts` - Core implementation
  - Type definitions for field types (f32, i32, u32, vec2, vec3, vec4, mat3x3, mat4x4)
  - `defineUniformStruct()` function
  - Alignment calculation following WGSL rules
  - WGSL code generation
  - TypeScript accessor generation

### Migration Files (in order of complexity)

1. **`src/game/debug-renderer/DebugShaderManager.ts`** - Good test case
   - 12 floats, includes i32 fields
   - Self-contained shader code in same file
   - Create `DebugUniforms` definition
   - Update `updateUniforms()` to use typed setters
   - Replace inline WGSL struct with generated code

2. **`src/core/graphics/webgpu/WebGPURenderer.ts`** - Simple mat3x3 case
   - Just a view matrix
   - Create `ViewUniforms` definition
   - Update `uploadViewMatrix()` to use typed setters
   - Replace inline WGSL struct with generated code

3. **`src/game/world-data/wind/webgpu/WindTileCompute.ts`** - Array literal pattern
   - Currently uses inline Float32Array initialization
   - Create `WindParams` definition in `WindStateShader.ts`
   - Export WGSL from shader, use in compute
   - Update `runCompute()` to use typed setters

4. **`src/game/world-data/terrain/webgpu/TerrainComputeBuffers.ts`** - DataView pattern
   - Uses DataView with byte offsets
   - Create `TerrainParams` definition
   - Export WGSL from `TerrainStateShader.ts`
   - Update `updateParams()` to use typed setters

5. **`src/game/world-data/water/webgpu/WaterComputeBuffers.ts`** - Complex layout
   - 144 bytes with mixed f32/u32
   - Create `WaterParams` definition
   - Export WGSL from `AnalyticalWaterStateShader.ts`
   - Update `updateParams()` to use typed setters

6. **`src/game/surface-rendering/SurfaceRenderer.ts`** - Most complex
   - 36 floats with multiple setter methods
   - Create `SurfaceUniforms` definition
   - Export WGSL from `SurfaceShader.ts`
   - Replace all `uniformData[index]` assignments
   - Remove individual setter methods (`setTime`, `setCameraMatrix`, etc.)

## Execution Order

### Phase 1: Core Implementation (Sequential)

1. Create `src/core/graphics/UniformStruct.ts`
   - Implement field type definitions with size/alignment info
   - Implement `defineUniformStruct()` with:
     - Layout calculation (respecting WGSL alignment rules)
     - WGSL struct string generation
     - Factory for creating instances with typed setters
   - Add unit tests or manual verification

### Phase 2: Migrations (Can Be Parallelized)

After Phase 1 is complete and tested, these can be done in parallel:

**Batch A (simpler, good for validation):**
- `DebugShaderManager.ts`
- `WebGPURenderer.ts`
- `WindTileCompute.ts` + `WindStateShader.ts`

**Batch B (more complex):**
- `TerrainComputeBuffers.ts` + `TerrainStateShader.ts`
- `WaterComputeBuffers.ts` + `AnalyticalWaterStateShader.ts`
- `SurfaceRenderer.ts` + `SurfaceShader.ts`

### Phase 3: Cleanup

- Remove any dead code (old layout comments, unused helper methods)
- Update documentation

## WGSL Alignment Rules Reference

These rules must be encoded in the implementation:

| Type | Size (bytes) | Alignment (bytes) |
|------|--------------|-------------------|
| f32, i32, u32 | 4 | 4 |
| vec2<f32> | 8 | 8 |
| vec3<f32> | 12 | 16 (!) |
| vec4<f32> | 16 | 16 |
| mat3x3<f32> | 48 | 16 (3 columns × 16 bytes each) |
| mat4x4<f32> | 64 | 16 |

Key gotcha: `vec3` has size 12 but alignment 16, meaning it effectively takes 16 bytes when followed by another field. `mat3x3` stores each column as a `vec3` with 16-byte stride.

## Risks & Considerations

1. **Runtime overhead**: Minimal - just replacing `array[index] = value` with method calls
2. **Type safety at boundaries**: The generated WGSL string must be embedded in shader code - mismatches would cause runtime errors, not compile errors
3. **Mixed i32/f32 fields**: Need to handle Int32Array overlay for integer fields
4. **Backward compatibility**: Old code continues to work during migration; can migrate incrementally
