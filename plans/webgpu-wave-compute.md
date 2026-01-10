# Gameplan: WebGPU Wave Computation Migration

Migrate wave computation from WebGL2 fullscreen shader to WebGPU compute shader with async readback for physics. Staged approach allows stopping after Stage 1.

---

## Current State

### Wave Computation (GPU - Rendering)
- `WaveComputeShader.ts` - Fragment shader computing Gerstner waves
- Renders to `RenderTargetTexture` (512×512 RGBA16F)
- Output sampled by `WaterShader` for water rendering
- Uses `FullscreenShader` base class (WebGL2)

### Wave Computation (CPU - Physics)
- `WaterInfo.getStateAtPoint()` - Duplicates Gerstner math on CPU
- Called 5-6 times per physics tick (120Hz) by Keel, Rudder, Hull
- Returns: `{velocity, surfaceHeight, surfaceHeightRate}`
- Latency-sensitive: 1 frame delay acceptable, 2+ frames noticeable

### Renderer
- `WebGLRenderer.ts` - Immediate-mode batched 2D renderer
- `RenderManager.ts` - Bridge between Game and renderer
- Context created in WebGLRenderer, passed via `getGL()`

---

## Desired Changes

### Stage 1: WebGPU Compute (Can Stop Here)
- Add WebGPU device alongside existing WebGL2 renderer
- Move wave computation to WebGPU compute shader
- Async readback wave data to CPU for physics
- Keep WebGL2 for all rendering (upload wave data as DataTexture)
- **Benefit:** Unified wave computation, no CPU/GPU duplication

### Stage 2: Full WebGPU Renderer
- Replace WebGL2 renderer with WebGPU
- Native texture sharing (no readback needed for rendering)
- Modern compute-first architecture
- **Benefit:** Cleaner architecture, better performance

---

## Stage 1: WebGPU Compute Only

### Files to Create

#### `src/core/graphics/webgpu/WebGPUDevice.ts`
Device initialization and management:
```typescript
export class WebGPUDevice {
  device: GPUDevice;
  async init(): Promise<void>;
  destroy(): void;
}
```
- Request adapter with `powerPreference: "high-performance"`
- Request device with required features/limits
- Singleton pattern - one device for the app

#### `src/core/graphics/webgpu/ComputeBuffer.ts`
Buffer abstraction for compute I/O:
```typescript
export class ComputeBuffer {
  // Storage buffer (GPU read/write)
  // Staging buffer (for async readback)
  async readback(): Promise<Float32Array>;
}
```
- Ring buffer of staging buffers for async readback
- Map/unmap lifecycle management

#### `src/core/graphics/webgpu/WaveComputeGPU.ts`
WebGPU compute shader for Gerstner waves:
```typescript
export class WaveComputeGPU {
  constructor(device: WebGPUDevice);
  setTime(t: number): void;
  setViewportBounds(left, top, width, height): void;
  compute(): void;
  async readbackRegion(x, y, w, h): Promise<Float32Array>;
}
```
- WGSL compute shader (port from GLSL)
- Workgroup size 8×8 for 512×512 texture
- Output to storage texture (r32float or rgba16float)
- Selective readback (small region around boat for physics)

### Files to Modify

#### `src/game/water/WaterComputePipeline.ts`
- Add WebGPU device initialization
- Replace `WaveComputeShader` with `WaveComputeGPU`
- After compute: readback small region, update CPU cache
- Upload full texture to WebGL `DataTexture` for rendering
- Keep `ModifierDataTexture` unchanged (still CPU-updated)

#### `src/game/water/WaterInfo.ts`
- Remove CPU Gerstner wave calculation (~140 lines)
- Query wave data from `WaterComputePipeline`'s cached readback
- Keep: current velocity (simplex noise), spatial hash, modifier queries
- Interpolate between cached wave samples for sub-pixel accuracy

#### `src/core/Game.ts`
- Initialize WebGPU device in `init()`
- Add `getWebGPUDevice()` accessor
- Poll async readback results each frame

### WGSL Shader (Wave Compute)

Port the existing GLSL to WGSL:
```wgsl
@group(0) @binding(0) var<storage, read_write> output: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> params: WaveParams;

struct WaveParams {
  time: f32,
  viewport: vec4<f32>,  // left, top, width, height
  waveData: array<f32, 96>,  // 12 waves × 8 floats
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let uv = vec2<f32>(id.xy) / vec2<f32>(512.0);
  let worldPos = params.viewport.xy + uv * params.viewport.zw;

  // Gerstner wave calculation (same math as GLSL)
  let result = calculateWaves(worldPos, params.time);

  let idx = id.y * 512 + id.x;
  output[idx] = result;
}
```

### Async Readback Strategy

**Problem:** Physics needs wave data at specific points, but GPU readback is async.

**Solution:** Double-buffered region cache
1. Each frame: dispatch compute for full 512×512 texture
2. Request async readback of small region around boat (e.g., 32×32)
3. Next frame: use previous frame's readback for physics
4. Interpolate within cached region for query points

**Latency:** 1 frame (8.3ms @ 120Hz physics) - acceptable per analysis.

### Execution Order (Stage 1)

```
## Phase 1.1: WebGPU Infrastructure (Parallel)
- [ ] WebGPUDevice.ts - Device init/management
- [ ] ComputeBuffer.ts - Buffer abstraction + readback

## Phase 1.2: Wave Compute (Sequential)
1. [ ] WaveComputeGPU.ts - Port GLSL → WGSL compute shader
2. [ ] WaterComputePipeline.ts - Integrate WebGPU compute
3. [ ] WaterInfo.ts - Use cached readback instead of CPU waves

## Phase 1.3: Integration
- [ ] Game.ts - Init WebGPU device
- [ ] Test: Water renders correctly, physics feels responsive
```

---

## Stage 2: Full WebGPU Renderer

### Files to Create

#### `src/core/graphics/webgpu/WebGPURenderer.ts`
Replace WebGLRenderer with WebGPU equivalent:
- Same immediate-mode batching API
- Vertex/index buffers as GPUBuffers
- Render pipeline for shapes/sprites
- Bind group management for textures/uniforms

#### `src/core/graphics/webgpu/WebGPUTextureManager.ts`
Texture loading and caching for WebGPU:
- `GPUTexture` instead of `WebGLTexture`
- Same interface as current TextureManager
- Support for storage textures (compute output)

#### `src/core/graphics/webgpu/WebGPUShaderProgram.ts`
WGSL shader compilation and pipeline creation:
- Render pipelines (vertex + fragment)
- Compute pipelines
- Bind group layout management

### Files to Modify

#### `src/core/graphics/RenderManager.ts`
- Accept renderer type in options: `'webgl' | 'webgpu'`
- Instantiate appropriate renderer
- Same public API, different backend

#### `src/core/graphics/Draw.ts`
- Should work unchanged (delegates to renderer)
- May need minor adjustments for texture binding

#### `src/game/water/WaterComputePipeline.ts`
- Remove WebGL DataTexture upload (no longer needed)
- Wave compute output directly sampled by WebGPU WaterShader
- Native texture sharing, no copy

#### `src/game/water/WaterShader.ts`
- Port GLSL fragment shader to WGSL
- Use render pipeline instead of FullscreenShader

### Execution Order (Stage 2)

```
## Phase 2.1: Core Renderer (Sequential)
1. [ ] WebGPUShaderProgram.ts - Pipeline management
2. [ ] WebGPUTextureManager.ts - Texture loading
3. [ ] WebGPURenderer.ts - Batched 2D rendering

## Phase 2.2: Shader Ports (Parallel)
- [ ] Port shape/sprite shaders to WGSL
- [ ] Port WaterShader to WGSL

## Phase 2.3: Integration (Sequential)
1. [ ] RenderManager.ts - Backend selection
2. [ ] Remove WebGL fallback code
3. [ ] Full testing pass
```

---

## Verification

### Stage 1 Tests
1. `npm run tsgo` - No type errors
2. `npm start` - Water renders (via DataTexture upload)
3. Sail the boat - Steering feels responsive (no input lag)
4. Check profiler - "wave-gpu-compute" timing, readback timing
5. Compare: Disable waves, measure physics tick time reduction

### Stage 2 Tests
1. All Stage 1 tests pass
2. Visual comparison - Rendering identical to WebGL version
3. Performance comparison - Frame time, GPU memory
4. Stress test - Multiple boats, many wake particles

---

## Key Files Summary

### Stage 1 (Compute Only)
| File | Action |
|------|--------|
| `src/core/graphics/webgpu/WebGPUDevice.ts` | CREATE |
| `src/core/graphics/webgpu/ComputeBuffer.ts` | CREATE |
| `src/core/graphics/webgpu/WaveComputeGPU.ts` | CREATE |
| `src/game/water/WaterComputePipeline.ts` | MODIFY |
| `src/game/water/WaterInfo.ts` | MODIFY (remove CPU waves) |
| `src/core/Game.ts` | MODIFY (init WebGPU) |

### Stage 2 (Full Renderer)
| File | Action |
|------|--------|
| `src/core/graphics/webgpu/WebGPURenderer.ts` | CREATE |
| `src/core/graphics/webgpu/WebGPUTextureManager.ts` | CREATE |
| `src/core/graphics/webgpu/WebGPUShaderProgram.ts` | CREATE |
| `src/core/graphics/RenderManager.ts` | MODIFY |
| `src/game/water/WaterShader.ts` | REWRITE (WGSL) |
| Multiple entity files | MINOR (texture type changes) |
