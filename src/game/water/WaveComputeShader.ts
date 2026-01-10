import { FullscreenShader } from "../../core/graphics/FullscreenShader";
import {
  NUM_WAVES,
  WAVE_CONSTANTS_GLSL,
  buildWaveDataArray,
} from "./WaterConstants";

const WAVE_COMPUTE_FRAGMENT_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 v_position;
out vec4 fragColor;

uniform float u_time;
uniform vec4 u_viewportBounds;  // [left, top, width, height] in world space
uniform vec2 u_textureSize;     // Texture dimensions

// Wave parameters: 12 waves x 8 floats each = 96 floats
// Each wave: [amplitude, wavelength, direction, phaseOffset, speedMult, sourceDist, offsetX, offsetY]
uniform float u_waveData[${NUM_WAVES * 8}];

${WAVE_CONSTANTS_GLSL}

// ============================================================================
// Simplex 3D Noise - ported from Ashima Arts / Stefan Gustavson
// https://github.com/ashima/webgl-noise
// ============================================================================

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float simplex3D(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  // First corner
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  // Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  // Permutations
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  // Gradients: 7x7 points over a square, mapped onto an octahedron
  float n_ = 0.142857142857; // 1.0/7.0
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  // Normalise gradients
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  // Mix final noise value
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ============================================================================
// Hash function for white noise
// ============================================================================

float hash2D(float x, float y) {
  float n = sin(x * 127.1 + y * 311.7) * 43758.5453;
  return fract(n);
}

// ============================================================================
// Gerstner Wave Calculation
// ============================================================================

vec4 calculateWaves(vec2 worldPos, float time) {
  float x = worldPos.x;
  float y = worldPos.y;

  // Sample amplitude modulation noise once per point
  float ampModTime = time * WAVE_AMP_MOD_TIME_SCALE;
  float ampMod = 1.0 + simplex3D(vec3(
    x * WAVE_AMP_MOD_SPATIAL_SCALE,
    y * WAVE_AMP_MOD_SPATIAL_SCALE,
    ampModTime
  )) * WAVE_AMP_MOD_STRENGTH;

  // First pass: compute Gerstner horizontal displacement
  float dispX = 0.0;
  float dispY = 0.0;

  for (int i = 0; i < NUM_WAVES; i++) {
    int base = i * 8;
    float amplitude = u_waveData[base + 0];
    float wavelength = u_waveData[base + 1];
    float direction = u_waveData[base + 2];
    float phaseOffset = u_waveData[base + 3];
    float speedMult = u_waveData[base + 4];
    float sourceDist = u_waveData[base + 5];
    float sourceOffsetX = u_waveData[base + 6];
    float sourceOffsetY = u_waveData[base + 7];

    float baseDx = cos(direction);
    float baseDy = sin(direction);
    float k = (2.0 * PI) / wavelength;
    float omega = sqrt(GRAVITY * k) * speedMult;

    float dx, dy, phase;

    if (sourceDist > 1e9) {
      // Planar wave
      dx = baseDx;
      dy = baseDy;
      float projected = x * dx + y * dy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      // Point source wave - curved wavefronts
      float sourceX = -baseDx * sourceDist + sourceOffsetX;
      float sourceY = -baseDy * sourceDist + sourceOffsetY;

      float toPointX = x - sourceX;
      float toPointY = y - sourceY;
      float distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      dx = toPointX / distFromSource;
      dy = toPointY / distFromSource;
      phase = k * distFromSource - omega * time + phaseOffset;
    }

    // Gerstner horizontal displacement
    float Q = GERSTNER_STEEPNESS / (k * amplitude * float(NUM_WAVES));
    float cosPhase = cos(phase);
    dispX += Q * amplitude * dx * cosPhase;
    dispY += Q * amplitude * dy * cosPhase;
  }

  // Second pass: compute height and dh/dt at displaced position
  float sampleX = x - dispX;
  float sampleY = y - dispY;
  float height = 0.0;
  float dhdt = 0.0;  // Rate of height change (time derivative)

  for (int i = 0; i < NUM_WAVES; i++) {
    int base = i * 8;
    float amplitude = u_waveData[base + 0];
    float wavelength = u_waveData[base + 1];
    float direction = u_waveData[base + 2];
    float phaseOffset = u_waveData[base + 3];
    float speedMult = u_waveData[base + 4];
    float sourceDist = u_waveData[base + 5];
    float sourceOffsetX = u_waveData[base + 6];
    float sourceOffsetY = u_waveData[base + 7];

    float baseDx = cos(direction);
    float baseDy = sin(direction);
    float k = (2.0 * PI) / wavelength;
    float omega = sqrt(GRAVITY * k) * speedMult;

    float phase;

    if (sourceDist > 1e9) {
      // Planar wave
      float projected = sampleX * baseDx + sampleY * baseDy;
      phase = k * projected - omega * time + phaseOffset;
    } else {
      // Point source wave
      float sourceX = -baseDx * sourceDist + sourceOffsetX;
      float sourceY = -baseDy * sourceDist + sourceOffsetY;

      float toPointX = sampleX - sourceX;
      float toPointY = sampleY - sourceY;
      float distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

      phase = k * distFromSource - omega * time + phaseOffset;
    }

    float sinPhase = sin(phase);
    float cosPhase = cos(phase);

    height += amplitude * ampMod * sinPhase;

    // dh/dt = d/dt[A * ampMod * sin(k*d - omega*t + phi)]
    //       = A * ampMod * cos(phase) * (-omega)
    //       = -A * ampMod * omega * cos(phase)
    dhdt += -amplitude * ampMod * omega * cosPhase;
  }

  // Add surface turbulence - small non-periodic noise
  float smoothTurbulence =
    simplex3D(vec3(x * 0.15, y * 0.15, time * 0.5)) * 0.03 +
    simplex3D(vec3(x * 0.4, y * 0.4, time * 0.8)) * 0.01;

  // White noise - changes per pixel, animated slowly with time
  float timeCell = floor(time * 0.5);
  float whiteTurbulence = (hash2D(x * 0.5 + timeCell, y * 0.5) - 0.5) * 0.02;

  height += smoothTurbulence + whiteTurbulence;
  // Note: turbulence contribution to dhdt is negligible and non-physical, so we skip it

  // Return height, displacement, and dhdt
  return vec4(height, dispX, dispY, dhdt);
}

void main() {
  // Convert clip space (-1,1) to texture UV (0,1)
  vec2 uv = v_position * 0.5 + 0.5;

  // Map UV to world position
  vec2 worldPos = u_viewportBounds.xy + uv * u_viewportBounds.zw;

  // Calculate waves
  vec4 waveResult = calculateWaves(worldPos, u_time);
  float height = waveResult.x;
  float dhdt = waveResult.w;  // Rate of height change

  // Pack output:
  // R: height (normalized, will be unpacked by water shader)
  // G: dh/dt (normalized rate of height change)
  // B: reserved (could store gradient in future)
  // A: reserved

  // Height range is roughly ±1.5 ft, so we map to 0-1 with 0.5 as neutral
  float normalizedHeight = height / 5.0 + 0.5;

  // dh/dt range is roughly ±5 ft/s, so we map to 0-1 with 0.5 as zero
  float normalizedDhdt = dhdt / 10.0 + 0.5;

  fragColor = vec4(normalizedHeight, normalizedDhdt, 0.5, 1.0);
}
`;

/**
 * GPU shader computing Gerstner wave surface → WaveTexture (512x512).
 *
 * Implements 12 configurable waves with:
 * - Two-pass Gerstner: horizontal displacement, then height at displaced position
 * - Amplitude modulation via 3D simplex noise (wave grouping effect)
 * - Planar waves (distant swells) and point-source waves (localized disturbances)
 * - Surface turbulence from simplex + white noise
 *
 * Output format (RGBA):
 * - R: Normalized height (height/5.0 + 0.5)
 * - G: Normalized dh/dt (rate of height change, for physics)
 * - B, A: Reserved (unused)
 */
export class WaveComputeShader extends FullscreenShader {
  private waveData: Float32Array;

  constructor(gl: WebGL2RenderingContext) {
    const waveData = buildWaveDataArray();

    super(gl, {
      fragmentSource: WAVE_COMPUTE_FRAGMENT_SHADER,
      uniforms: {
        u_time: { type: "1f", value: 0 },
        u_viewportBounds: { type: "4f", value: [0, 0, 100, 100] },
        u_textureSize: { type: "2f", value: [128, 128] },
      },
      textures: [],
    });

    this.waveData = waveData;

    // Set wave data uniform (array of floats)
    this.program.use();
    this.program.setUniform1fv("u_waveData", this.waveData);
  }

  setTime(time: number): void {
    this.uniforms.u_time.value = time;
  }

  setViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    this.uniforms.u_viewportBounds.value[0] = left;
    this.uniforms.u_viewportBounds.value[1] = top;
    this.uniforms.u_viewportBounds.value[2] = width;
    this.uniforms.u_viewportBounds.value[3] = height;
  }

  setTextureSize(width: number, height: number): void {
    this.uniforms.u_textureSize.value[0] = width;
    this.uniforms.u_textureSize.value[1] = height;
  }

  /**
   * Render the wave computation to the currently bound framebuffer.
   */
  compute(): void {
    this.render({});
  }
}
