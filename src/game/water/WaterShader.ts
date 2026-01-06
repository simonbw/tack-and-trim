import { defaultFilterVert, Filter, GlProgram } from "pixi.js";

const fragment = /*glsl*/ `
  precision highp float;

  in vec2 vTextureCoord;

  uniform sampler2D uTexture;
  uniform vec4 uInputSize;
  uniform vec4 uOutputFrame;

  uniform mat3 uCameraMatrix;
  uniform float uResolution;
  uniform float uTime;

  // Simple hash function for noise
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // Smooth noise
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // Fractal Brownian Motion for more interesting patterns
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  void main(void) {
    vec2 screenPos = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
    vec2 worldPos = (uCameraMatrix * vec3(screenPos, 1.0)).xy / uResolution;

    // Scale world position for nice wave sizes
    vec2 p = worldPos * 0.02;
    float time = uTime * 0.5;

    // Create layered wave patterns
    float wave1 = sin(p.x * 2.0 + p.y * 1.5 + time) * 0.5 + 0.5;
    float wave2 = sin(p.x * 1.0 - p.y * 2.0 + time * 0.7) * 0.5 + 0.5;
    float wave3 = fbm(p * 3.0 + vec2(time * 0.3, time * 0.2));

    // Combine waves
    float waves = wave1 * 0.3 + wave2 * 0.3 + wave3 * 0.4;

    // Ocean color palette
    vec3 deepColor = vec3(0.05, 0.15, 0.35);   // Deep blue
    vec3 midColor = vec3(0.1, 0.3, 0.5);       // Mid blue
    vec3 highlightColor = vec3(0.3, 0.5, 0.7); // Light blue highlights

    // Mix colors based on wave intensity
    vec3 color = mix(deepColor, midColor, waves);
    color = mix(color, highlightColor, pow(waves, 3.0) * 0.5);

    // Add subtle foam/sparkle on wave peaks
    float foam = smoothstep(0.65, 0.75, waves) * 0.3;
    color += vec3(foam);

    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Create a water shader filter.
 */
export function createWaterShader(): Filter {
  return new Filter({
    glProgram: new GlProgram({ fragment, vertex: defaultFilterVert }),
    resources: {
      waterUniforms: {
        uResolution: { value: 1, type: "f32" },
        uTime: { value: 0, type: "f32" },
        uCameraMatrix: {
          value: new Float32Array(9),
          type: "mat3x3<f32>",
        },
      },
    },
  });
}
