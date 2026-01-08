# Water Shader Improvements Plan

Make the water look more like real top-down water by adding foam, sharp edges, and better color variation - all in the shader without changing wave simulation.

## Goals
- Add subtle, scattered foam/whitecaps at wave crests (tunable for weather)
- Add high-frequency detail to break up smooth blobs
- Improve color variation beyond simple height-based blending

## Files to Modify
- `src/game/water/WaterShader.ts` - GLSL shader + uniform management
- `src/game/water/WaterRenderer.ts` - Pass new uniform values

---

## Implementation

### 1. Add New Uniforms

```typescript
// Foam control
u_foamThreshold: 0.65      // Height threshold for foam
u_foamIntensity: 0.7       // Overall foam brightness
u_foamCoverage: 0.4        // How much area gets foam patches
u_foamSharpness: 3.0       // Edge sharpness

// Ripple detail
u_rippleStrength: 0.15     // Normal perturbation strength
u_rippleScale: 1.0         // World-space scale

// Color variation
u_colorNoiseStrength: 0.1  // Hue shift strength
```

### 2. GLSL: Hash/Noise Functions

Add at top of fragment shader:
```glsl
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float valueNoise(vec2 uv) {
  vec2 ip = floor(uv);
  vec2 fp = fract(uv);
  fp = fp * fp * (3.0 - 2.0 * fp);
  float a = hash21(ip);
  float b = hash21(ip + vec2(1.0, 0.0));
  float c = hash21(ip + vec2(0.0, 1.0));
  float d = hash21(ip + vec2(1.0, 1.0));
  return mix(mix(a, b, fp.x), mix(c, d, fp.x), fp.y);
}
```

### 3. GLSL: Foam Calculation

Detect foam from wave crests + gradient steepness + noise breakup:
```glsl
float calculateFoam(float height, float gradientMag, vec2 worldPos, float time) {
  // Height-based (wave peaks)
  float heightFoam = smoothstep(u_foamThreshold, u_foamThreshold + 0.15, height);

  // Slope-based (steep = breaking)
  float slopeFoam = smoothstep(0.3, 0.7, gradientMag);

  float baseFoam = max(heightFoam, slopeFoam * 0.4);

  // Noise breakup for patchy appearance
  float noise = valueNoise(worldPos * 0.12 + time * 0.3);
  noise += valueNoise(worldPos * 0.25 - time * 0.2) * 0.5;
  noise /= 1.5;

  float threshold = 1.0 - u_foamCoverage;
  float foamMask = smoothstep(threshold - 0.1, threshold + 0.1, noise);

  return pow(baseFoam * foamMask * u_foamIntensity, 1.0 / u_foamSharpness);
}
```

### 4. GLSL: High-Frequency Ripples

Sin-based analytical noise for sharp micro-detail:
```glsl
vec2 rippleNoise(vec2 uv, float time) {
  vec2 n = vec2(0.0);
  n += vec2(sin(uv.x * 23.0 + uv.y * 17.0 + time * 2.3),
            sin(uv.x * 19.0 - uv.y * 23.0 + time * 1.9)) * 0.5;
  n += vec2(sin(uv.x * 47.0 + uv.y * 31.0 - time * 3.1),
            sin(uv.x * 37.0 - uv.y * 43.0 + time * 2.7)) * 0.3;
  n += vec2(sin(uv.x * 89.0 - uv.y * 67.0 + time * 4.1),
            sin(uv.x * 73.0 + uv.y * 61.0 - time * 3.7)) * 0.2;
  return n;
}
```

Perturb normal after base calculation:
```glsl
vec2 ripple = rippleNoise(worldPos * u_rippleScale * 0.08, u_time);
normal = normalize(vec3(
  normal.x + ripple.x * u_rippleStrength,
  normal.y + ripple.y * u_rippleStrength,
  normal.z
));
```

### 5. GLSL: Color Variation

Replace simple height blend with richer calculation:
```glsl
// Slope-based: sun-facing surfaces warmer, away surfaces cooler
float sunFacing = dot(normal.xy, sunDir.xy);
vec3 slopeShift = mix(vec3(-0.03, -0.01, 0.03), vec3(0.03, 0.05, -0.02), sunFacing * 0.5 + 0.5);

// Noise-based hue variation
float colorNoise = valueNoise(worldPos * 0.02 + u_time * 0.05);
vec3 hueShift = mix(vec3(-0.02, 0.02, 0.04), vec3(0.02, 0.04, -0.02), colorNoise);

// Troughs darker and more saturated
float troughDarken = (1.0 - rawHeight) * 0.15;

baseColor = baseColor + slopeShift * 0.2 + hueShift * u_colorNoiseStrength;
baseColor *= (1.0 - troughDarken);
```

### 6. Final Color Blend

After lighting calculation, blend foam:
```glsl
float gradientMag = length(normal.xy);
float foam = calculateFoam(rawHeight, gradientMag, worldPos, u_time);
vec3 foamColor = vec3(0.92, 0.95, 0.98);
color = mix(color, foamColor, foam * 0.85);
```

### 7. TypeScript: WaterShader Class

Add private members, setters, and uniform uploads:
- Add fields for each new uniform with defaults
- Add setter methods (e.g., `setFoamThreshold(value)`)
- In `render()`, call `setUniform1f`/`setUniform3f` for each

### 8. TypeScript: WaterRenderer

Add method to configure weather presets:
```typescript
setWeatherConditions(preset: 'calm' | 'moderate' | 'choppy') {
  // Adjust foam/ripple uniforms based on preset
}
```

---

## Verification

1. Run `npm start` and observe water rendering
2. Check foam appears on wave crests, patchy and organic
3. Verify sharp micro-detail visible (not smooth blobs)
4. Confirm color varies across the surface (not uniform)
5. Toggle debug mode ('B' key) to verify data texture still works
6. Test performance - should not noticeably impact framerate
