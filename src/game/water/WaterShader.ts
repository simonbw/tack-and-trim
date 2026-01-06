import { Filter, GlProgram, Texture } from "pixi.js";

/**
 * Custom water shader that renders an infinite ocean with simple wave patterns.
 * Uses world-space coordinates so the pattern stays fixed as the camera moves.
 */
export class WaterShader extends Filter {
  constructor() {
    const glProgram = GlProgram.from({
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
    });

    super({
      glProgram,
      resources: {
        waterUniforms: {
          uTime: { value: 0, type: "f32" },
          uCameraPosition: { value: [0, 0], type: "vec2<f32>" },
          uCameraZoom: { value: 1, type: "f32" },
          uResolution: { value: [1, 1], type: "vec2<f32>" },
        },
      },
    });
  }

  /** Update time uniform for animation */
  set time(value: number) {
    this.resources.waterUniforms.uniforms.uTime = value;
  }

  get time(): number {
    return this.resources.waterUniforms.uniforms.uTime;
  }

  /** Update camera position for world-space coordinates */
  set cameraPosition(value: [number, number]) {
    this.resources.waterUniforms.uniforms.uCameraPosition = value;
  }

  /** Update camera zoom level */
  set cameraZoom(value: number) {
    this.resources.waterUniforms.uniforms.uCameraZoom = value;
  }

  /** Update screen resolution */
  set resolution(value: [number, number]) {
    this.resources.waterUniforms.uniforms.uResolution = value;
  }
}

const VERTEX_SHADER = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform float uTime;
uniform vec2 uCameraPosition;
uniform float uCameraZoom;
uniform vec2 uResolution;

// Simple hash function for pseudo-random values
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Value noise
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // Smoothstep

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Fractal Brownian Motion for more interesting noise
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;

    for (int i = 0; i < 4; i++) {
        value += amplitude * noise(p * frequency);
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    return value;
}

void main() {
    // Convert screen coordinates to world coordinates
    vec2 screenPos = vTextureCoord * uResolution;
    vec2 centeredScreen = screenPos - uResolution * 0.5;
    vec2 worldPos = centeredScreen / uCameraZoom + uCameraPosition;

    // Scale for wave pattern (adjust divisor for wave size)
    vec2 scaledPos = worldPos / 50.0;

    // Base ocean color
    vec3 deepColor = vec3(0.1, 0.3, 0.5);
    vec3 shallowColor = vec3(0.2, 0.5, 0.7);
    vec3 highlightColor = vec3(0.4, 0.7, 0.9);

    // Animated wave patterns using noise
    float time = uTime * 0.5;

    // Large slow waves
    float wave1 = fbm(scaledPos * 0.3 + vec2(time * 0.1, time * 0.05));

    // Medium waves moving in different direction
    float wave2 = fbm(scaledPos * 0.7 + vec2(-time * 0.15, time * 0.1));

    // Small detail waves
    float wave3 = noise(scaledPos * 2.0 + vec2(time * 0.2, -time * 0.15));

    // Combine waves
    float combinedWaves = wave1 * 0.5 + wave2 * 0.35 + wave3 * 0.15;

    // Color mixing based on wave height
    vec3 waterColor = mix(deepColor, shallowColor, combinedWaves);

    // Add subtle highlights on wave peaks
    float highlight = smoothstep(0.55, 0.7, combinedWaves);
    waterColor = mix(waterColor, highlightColor, highlight * 0.3);

    // Add very subtle variation for sparkle effect
    float sparkle = noise(scaledPos * 8.0 + time);
    sparkle = pow(sparkle, 8.0) * 0.15;
    waterColor += vec3(sparkle);

    finalColor = vec4(waterColor, 1.0);
}
`;
