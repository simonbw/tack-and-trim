# Gameplan: Full WebGPU Migration

Replace the entire WebGL2 rendering pipeline with WebGPU. This includes the 2D renderer, all shaders (ported to WGSL), texture management, and wave computation. The result is a clean WebGPU-native architecture with compute shaders for wave physics and direct texture sharing.

**Requirements:**
- WebGPU required (no WebGL2 fallback)
- Game-specific code stays in `src/game/`, engine code in `src/core/`

---

## Current Architecture Overview

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Core Renderer | `src/core/graphics/WebGLRenderer.ts` | 1-765 | Batched 2D rendering |
| Shape Shader | `src/core/graphics/ShaderProgram.ts` | 195-231 | Untextured primitives |
| Sprite Shader | `src/core/graphics/ShaderProgram.ts` | 233-277 | Textured quads |
| Water Shader | `src/game/water/WaterShader.ts` | 17-154 | Water surface rendering |
| Wave Compute | `src/game/water/WaveComputeShader.ts` | 8-267 | Gerstner wave computation |
| Texture Manager | `src/core/graphics/TextureManager.ts` | 1-290 | Texture loading/caching |
| Render Targets | `src/core/graphics/texture/RenderTargetTexture.ts` | 1-202 | Off-screen rendering |
| Data Textures | `src/core/graphics/texture/DataTexture.ts` | 1-105 | CPU-updated textures |
| GPU Timing | `src/core/graphics/GpuTimer.ts` | 1-143 | Performance measurement |

---

## Implementation Phases

### Phase 1: WebGPU Infrastructure (Engine)
Foundation classes that everything else builds on.

**Create `src/core/graphics/webgpu/WebGPUDevice.ts`**
- Adapter/device initialization with `powerPreference: "high-performance"`
- Feature detection and capability reporting
- Singleton pattern for app-wide device access
- Throw error if WebGPU unavailable (no fallback)

**Create `src/core/graphics/webgpu/WebGPUTextureManager.ts`**
- Same interface as existing TextureManager
- Texture loading from URL, Image, Canvas, raw pixels
- Texture caching with deduplication
- Format: RGBA8 for sprites, RGBA16Float for render targets
- Sampler creation (LINEAR filtering, CLAMP_TO_EDGE)

### Phase 2: Core Renderer (Engine)
The batched 2D renderer - most critical component.

**Create `src/core/graphics/webgpu/WebGPURenderer.ts`**
Replicate WebGLRenderer's architecture:
- **Two batch types**: shapes (untextured) and sprites (textured)
- **Vertex formats**:
  - Shape: position(2) + color(4) + modelMatrix(6) = 12 floats/vertex
  - Sprite: position(2) + uv(2) + color(4) + modelMatrix(6) = 14 floats/vertex
- **Batching**: Flush on overflow or texture change
- **Transform stack**: Same Matrix3-based API
- **Blend mode**: SRC_ALPHA, ONE_MINUS_SRC_ALPHA

**Create WGSL shaders:**

`src/core/graphics/webgpu/shaders/shape.wgsl`:
```wgsl
struct Uniforms { viewMatrix: mat3x3<f32> }
struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) modelCol0: vec2<f32>,
  @location(3) modelCol1: vec2<f32>,
  @location(4) modelCol2: vec2<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  // Reconstruct 3x3 model matrix from per-vertex attributes
  // Apply model transform then view matrix
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;  // Direct color output
}
```

`src/core/graphics/webgpu/shaders/sprite.wgsl`:
- Same as shape + texture sampling with tint multiplication

### Phase 3: Fullscreen Effects (Engine)
Infrastructure for water rendering and post-processing.

**Create `src/core/graphics/webgpu/WebGPUFullscreenQuad.ts`**
- Static vertex buffer covering clip space
- Reusable for all fullscreen effects

**Create `src/core/graphics/webgpu/WebGPURenderTarget.ts`**
- GPUTexture with render attachment capability
- Support for RGBA8 and RGBA16Float formats
- Samplable for use as input to other passes

### Phase 4: Wave Computation (Game-Specific)
The key motivation - native compute + direct texture sharing.

**Create `src/game/water/webgpu/WaveComputeGPU.ts`**
Port GLSL fragment shader to WGSL compute shader:
- **Workgroup size**: 8×8 for 512×512 texture
- **Output**: Storage texture (rgba16float)
- **Readback**: `buffer.mapAsync()` for physics data

**Create `src/game/water/webgpu/waveCompute.wgsl`**
Port from `WaveComputeShader.ts:8-267`:
- 3D simplex noise (amplitude modulation + turbulence)
- Two-pass Gerstner wave algorithm
- 12 wave components from uniform buffer
- Output: height (R), dh/dt (G)

```wgsl
struct WaveParams {
  time: f32,
  viewport: vec4<f32>,  // left, top, width, height
  textureSize: vec2<f32>,
  waveData: array<f32, 96>,  // 12 waves × 8 floats
}

@group(0) @binding(0) var<uniform> params: WaveParams;
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let uv = vec2<f32>(id.xy) / params.textureSize;
  let worldPos = params.viewport.xy + uv * params.viewport.zw;

  // Pass 1: Compute horizontal displacement
  var dispX = 0.0;
  var dispY = 0.0;
  for (var i = 0; i < 12; i++) {
    // Gerstner displacement calculation
  }

  // Pass 2: Sample height at displaced position
  var height = 0.0;
  var dhdt = 0.0;
  for (var i = 0; i < 12; i++) {
    // Height calculation at (worldPos.x - dispX, worldPos.y - dispY)
  }

  // Add turbulence (simplex noise)
  height += simplex3D(worldPos.x * 0.15, worldPos.y * 0.15, params.time * 0.3) * 0.1;

  // Normalize and write output
  let normalizedHeight = height / 5.0 + 0.5;
  let normalizedDhdt = dhdt / 10.0 + 0.5;
  textureStore(output, id.xy, vec4(normalizedHeight, normalizedDhdt, 0.5, 1.0));
}
```

### Phase 5: Water Rendering (Game-Specific)
Port the water surface shader.

**Create `src/game/water/webgpu/water.wgsl`**
Port from `WaterShader.ts:17-154`:
- Sample wave texture (now native WebGPU texture)
- Sample modifier texture (wakes)
- Surface normal calculation from height gradients
- Fresnel, subsurface scattering, diffuse/specular lighting
- Height-based color interpolation

**Modify `src/game/water/WaterComputePipeline.ts`**
- Use WebGPU compute shader instead of WebGL fragment shader
- Output directly to WebGPU texture (no readback for rendering)
- Add async readback for physics (region around boat)

**Modify `src/game/water/WaterInfo.ts`**
- Query cached GPU readback for wave data
- Keep CPU fallback for out-of-range queries or immediate answers

### Phase 6: Integration
Wire everything together.

**Modify `src/core/Game.ts`**
- Initialize WebGPU device before renderer
- Add `getWebGPUDevice()` accessor
- Update render loop to work with WebGPU

**Modify `src/core/graphics/RenderManager.ts`**
- Replace WebGLRenderer with WebGPURenderer
- Same public API, WebGPU backend only

**Update entity rendering:**
- Most entities use Draw API - should work unchanged
- WaterRenderer needs WebGPU-specific code path

---

## File Summary

### Create (Engine - `src/core/graphics/webgpu/`)
| File | Purpose |
|------|---------|
| `WebGPUDevice.ts` | Device management |
| `WebGPURenderer.ts` | Batched 2D renderer |
| `WebGPUTextureManager.ts` | Texture loading |
| `WebGPURenderTarget.ts` | Off-screen textures |
| `WebGPUFullscreenQuad.ts` | Fullscreen geometry |
| `shaders/shape.wgsl` | Untextured primitives |
| `shaders/sprite.wgsl` | Textured quads |

### Create (Game - `src/game/water/webgpu/`)
| File | Purpose |
|------|---------|
| `WaveComputeGPU.ts` | Wave compute shader wrapper |
| `waveCompute.wgsl` | Gerstner waves (WGSL) |
| `water.wgsl` | Water surface (WGSL) |

### Modify
| File | Changes |
|------|---------|
| `src/core/Game.ts` | Init WebGPU device |
| `src/core/graphics/RenderManager.ts` | Use WebGPURenderer |
| `src/game/water/WaterComputePipeline.ts` | Use WebGPU compute |
| `src/game/water/WaterInfo.ts` | Use GPU readback |
| `src/game/water/WaterRenderer.ts` | WebGPU render path |

### Can Remove Later (After Migration Complete)
| File | Reason |
|------|--------|
| `src/core/graphics/WebGLRenderer.ts` | Replaced by WebGPURenderer |
| `src/core/graphics/ShaderProgram.ts` | WebGL-specific |
| `src/core/graphics/GpuTimer.ts` | WebGL-specific timing |
| `src/core/graphics/FullscreenShader.ts` | WebGL-specific |
| `src/core/graphics/FullscreenQuad.ts` | WebGL-specific |
| `src/core/graphics/texture/RenderTargetTexture.ts` | WebGL-specific |
| `src/game/water/WaveComputeShader.ts` | Replaced by WaveComputeGPU |

---

## Execution Order

```
Phase 1: Infrastructure (Engine)
├── WebGPUDevice.ts
└── WebGPUTextureManager.ts

Phase 2: Core Renderer (Engine - biggest piece)
├── shaders/shape.wgsl
├── shaders/sprite.wgsl
└── WebGPURenderer.ts

Phase 3: Fullscreen Effects (Engine)
├── WebGPUFullscreenQuad.ts
└── WebGPURenderTarget.ts

Phase 4: Wave Computation (Game)
├── webgpu/waveCompute.wgsl (port simplex + Gerstner)
└── webgpu/WaveComputeGPU.ts

Phase 5: Water Rendering (Game)
├── webgpu/water.wgsl
├── WaterComputePipeline.ts (modify)
└── WaterInfo.ts (modify)

Phase 6: Integration
├── Game.ts (modify)
├── RenderManager.ts (modify)
└── Testing
```

---

## Key Algorithm: Simplex Noise in WGSL

The wave shader uses 3D simplex noise for amplitude modulation and turbulence. This needs careful porting from GLSL (WaveComputeShader.ts:34-98):

```wgsl
// Simplex 3D noise - port from GLSL
fn mod289_3(x: vec3<f32>) -> vec3<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn mod289_4(x: vec4<f32>) -> vec4<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn permute(x: vec4<f32>) -> vec4<f32> {
  return mod289_4(((x * 34.0) + 1.0) * x);
}

fn taylorInvSqrt(r: vec4<f32>) -> vec4<f32> {
  return 1.79284291400159 - 0.85373472095314 * r;
}

fn simplex3D(v: vec3<f32>) -> f32 {
  // Full simplex noise implementation
  // ~50 lines of WGSL
}
```

---

## Key Algorithm: Two-Pass Gerstner Waves

The Gerstner wave algorithm must be ported exactly (WaveComputeShader.ts:113-239):

**Pass 1 - Horizontal Displacement:**
- For each of 12 waves, calculate displacement in X and Y
- Handle planar waves (sourceDist > 1e9) vs point-source waves
- Apply Gerstner steepness factor Q

**Pass 2 - Height at Displaced Position:**
- Sample at (x - dispX, y - dispY)
- Calculate height = amplitude × ampMod × sin(phase)
- Calculate dh/dt = -amplitude × ampMod × omega × cos(phase)

---

## Verification

1. **Type check**: `npm run tsgo` - no errors
2. **Basic rendering**: Shapes and sprites render correctly
3. **Water rendering**: Water looks identical to WebGL version
4. **Physics**: Boat steering feels responsive (no input lag)
5. **Performance**: Frame time comparable to or better than WebGL
6. **Error handling**: Clear error message if WebGPU unavailable

---

## Risk Areas

1. **Simplex noise in WGSL** - Complex algorithm, must port carefully
2. **Batching performance** - Buffer management differs from WebGL
3. **Texture format compatibility** - RGBA16Float support varies
4. **Transform stack** - Per-vertex model matrix must work correctly

**Note**: WebGPU is required - Chrome/Edge stable, Firefox/Safari experimental as of 2025.

---

## Estimated Scope

- **New files**: ~10 files, ~2000-3000 lines
- **Modified files**: ~5 files, ~200-300 lines changed
- **Deleted code**: ~200 lines (CPU wave duplication in WaterInfo.ts)
- **Removable code**: ~1500 lines (WebGL-specific code after migration)
