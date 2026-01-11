# Water Shader Improvements Plan

Make the water look more like real top-down water by adding foam, sharp edges, and better color variation - all in the shader without changing wave simulation.

## Goals
- Add subtle, scattered foam/whitecaps at wave crests (tunable for weather)
- Add high-frequency ripple detail to break up smooth blobs
- ~~Improve color variation beyond simple height-based blending~~ ✓ Done

## Current State

The water rendering has moved to WebGPU with WGSL shaders. The following has already been implemented in `WaterShaderGPU.ts`:

**Implemented:**
- Hash function (`hash21`) for procedural noise
- Slope-based color variation (sun-facing surfaces warmer)
- Trough darkening
- Basic fine noise for surface detail

**Not yet implemented:**
- Foam/whitecaps at wave crests
- High-frequency ripple normal perturbation
- Value noise for patchy foam breakup
- Weather presets (calm/moderate/choppy)

## Files to Modify
- `src/game/water/webgpu/WaterShaderGPU.ts` - WGSL shader + uniform management
- `src/game/water/webgpu/WaterRendererGPU.ts` - Pass new uniform values

---

## Implementation

### 1. Add New Uniforms

Update the uniform struct in `WaterShaderGPU.ts`:

```wgsl
struct Uniforms {
  // ... existing fields ...
  foamThreshold: f32,     // Height threshold for foam (default: 0.65)
  foamIntensity: f32,     // Overall foam brightness (default: 0.7)
  foamCoverage: f32,      // How much area gets foam patches (default: 0.4)
  foamSharpness: f32,     // Edge sharpness (default: 3.0)
  rippleStrength: f32,    // Normal perturbation strength (default: 0.15)
  rippleScale: f32,       // World-space scale (default: 1.0)
}
```

### 2. WGSL: Value Noise Function

Add value noise for foam breakup (alongside existing `hash21`):

```wgsl
fn valueNoise(uv: vec2<f32>) -> f32 {
  let ip = floor(uv);
  var fp = fract(uv);
  fp = fp * fp * (3.0 - 2.0 * fp);  // Smoothstep
  let a = hash21(ip);
  let b = hash21(ip + vec2<f32>(1.0, 0.0));
  let c = hash21(ip + vec2<f32>(0.0, 1.0));
  let d = hash21(ip + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, fp.x), mix(c, d, fp.x), fp.y);
}
```

### 3. WGSL: Foam Calculation

Detect foam from wave crests + gradient steepness + noise breakup:

```wgsl
fn calculateFoam(height: f32, gradientMag: f32, worldPos: vec2<f32>, time: f32) -> f32 {
  // Height-based (wave peaks)
  let heightFoam = smoothstep(uniforms.foamThreshold, uniforms.foamThreshold + 0.15, height);

  // Slope-based (steep = breaking)
  let slopeFoam = smoothstep(0.3, 0.7, gradientMag);

  let baseFoam = max(heightFoam, slopeFoam * 0.4);

  // Noise breakup for patchy appearance
  var noise = valueNoise(worldPos * 0.12 + time * 0.3);
  noise = noise + valueNoise(worldPos * 0.25 - time * 0.2) * 0.5;
  noise = noise / 1.5;

  let threshold = 1.0 - uniforms.foamCoverage;
  let foamMask = smoothstep(threshold - 0.1, threshold + 0.1, noise);

  return pow(baseFoam * foamMask * uniforms.foamIntensity, 1.0 / uniforms.foamSharpness);
}
```

### 4. WGSL: High-Frequency Ripples

Sin-based analytical noise for sharp micro-detail:

```wgsl
fn rippleNoise(uv: vec2<f32>, time: f32) -> vec2<f32> {
  var n = vec2<f32>(0.0);
  n = n + vec2<f32>(sin(uv.x * 23.0 + uv.y * 17.0 + time * 2.3),
                    sin(uv.x * 19.0 - uv.y * 23.0 + time * 1.9)) * 0.5;
  n = n + vec2<f32>(sin(uv.x * 47.0 + uv.y * 31.0 - time * 3.1),
                    sin(uv.x * 37.0 - uv.y * 43.0 + time * 2.7)) * 0.3;
  n = n + vec2<f32>(sin(uv.x * 89.0 - uv.y * 67.0 + time * 4.1),
                    sin(uv.x * 73.0 + uv.y * 61.0 - time * 3.7)) * 0.2;
  return n;
}
```

Perturb normal after base calculation:

```wgsl
let ripple = rippleNoise(worldPos * uniforms.rippleScale * 0.08, uniforms.time);
normal = normalize(vec3<f32>(
  normal.x + ripple.x * uniforms.rippleStrength,
  normal.y + ripple.y * uniforms.rippleStrength,
  normal.z
));
```

### 5. Final Color Blend

After lighting calculation, blend foam:

```wgsl
let gradientMag = length(normal.xy);
let foam = calculateFoam(rawHeight, gradientMag, worldPos, uniforms.time);
let foamColor = vec3<f32>(0.92, 0.95, 0.98);
color = mix(color, foamColor, foam * 0.85);
```

### 6. TypeScript: Update Uniform Buffer

In `WaterShaderGPU.ts`:
- Extend `uniformData` array to include new fields
- Update buffer size (round to 16-byte alignment)
- Add setter methods for each new uniform

### 7. TypeScript: Weather Presets

Add to `WaterRendererGPU.ts`:

```typescript
setWeatherConditions(preset: 'calm' | 'moderate' | 'choppy') {
  const presets = {
    calm: { foamThreshold: 0.8, foamIntensity: 0.3, foamCoverage: 0.2, rippleStrength: 0.08 },
    moderate: { foamThreshold: 0.65, foamIntensity: 0.7, foamCoverage: 0.4, rippleStrength: 0.15 },
    choppy: { foamThreshold: 0.5, foamIntensity: 0.9, foamCoverage: 0.6, rippleStrength: 0.25 },
  };
  const p = presets[preset];
  this.waterShader.setFoamThreshold(p.foamThreshold);
  this.waterShader.setFoamIntensity(p.foamIntensity);
  this.waterShader.setFoamCoverage(p.foamCoverage);
  this.waterShader.setRippleStrength(p.rippleStrength);
}
```

---

## Execution Order

1. Add value noise function to shader (simple addition)
2. Add ripple noise function and integrate with normal calculation
3. Add foam calculation function
4. Extend uniform struct and buffer
5. Add setter methods to WaterShaderGPU
6. Integrate foam into final color output
7. Add weather presets to WaterRendererGPU
8. Tune values for visual quality

---

## Verification

1. Run `npm start` and observe water rendering
2. Check foam appears on wave crests, patchy and organic
3. Verify sharp micro-detail visible (not smooth blobs)
4. Confirm existing color variation still works
5. Toggle debug mode ('B' key) to verify data texture still works
6. Test performance - should not noticeably impact framerate
7. Test weather presets cycle through visible changes
