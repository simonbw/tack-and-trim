import { FullscreenShader } from "../../core/graphics/FullscreenShader";
import { WATER_TEXTURE_SIZE } from "./WaterConstants";

const WATER_VERTEX_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 a_position;

out vec2 v_position;

void main() {
  v_position = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const WATER_FRAGMENT_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 v_position;
out vec4 fragColor;

uniform mat3 u_cameraMatrix;
uniform float u_time;
uniform vec4 u_viewportBounds;  // [left, top, width, height] in world space
uniform vec2 u_screenSize;      // Screen size in pixels
uniform sampler2D u_waterData;  // 64x64 data texture with height/velocity
uniform int u_renderMode;       // 0 = realistic, 1 = debug height

// Foam uniforms
uniform float u_foamThreshold;
uniform float u_foamIntensity;
uniform float u_foamCoverage;
uniform float u_foamSharpness;

// Color variation uniforms
uniform float u_colorNoiseStrength;

const float PI = 3.14159265359;

// Hash function for procedural noise - scalar output
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Hash function for procedural noise - vec2 output (for Worley)
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Value noise with smooth interpolation
float valueNoise(vec2 uv) {
  vec2 ip = floor(uv);
  vec2 fp = fract(uv);
  fp = fp * fp * (3.0 - 2.0 * fp); // Smoothstep
  float a = hash21(ip);
  float b = hash21(ip + vec2(1.0, 0.0));
  float c = hash21(ip + vec2(0.0, 1.0));
  float d = hash21(ip + vec2(1.0, 1.0));
  return mix(mix(a, b, fp.x), mix(c, d, fp.x), fp.y);
}

// Worley (cellular) noise - creates sharp angular cell boundaries
// Returns vec2: x = distance to nearest cell point, y = edge factor (distance to second nearest - nearest)
vec2 worleyNoise(vec2 uv) {
  vec2 ip = floor(uv);
  vec2 fp = fract(uv);

  float minDist = 1.0;
  float secondMinDist = 1.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 neighbor = vec2(float(i), float(j));
      vec2 cellPoint = neighbor + hash22(ip + neighbor) - fp;
      float dist = length(cellPoint);

      if (dist < minDist) {
        secondMinDist = minDist;
        minDist = dist;
      } else if (dist < secondMinDist) {
        secondMinDist = dist;
      }
    }
  }

  return vec2(minDist, secondMinDist - minDist);
}

// Ridged noise - creates sharp crease lines
float ridgedNoise(vec2 uv, float time) {
  float n = 0.0;
  float amp = 0.5;
  float freq = 1.0;

  for (int i = 0; i < 4; i++) {
    // 1 - abs(noise) creates sharp ridges at zero crossings
    float noiseVal = valueNoise(uv * freq + time * 0.02);
    n += amp * (1.0 - abs(noiseVal * 2.0 - 1.0));
    amp *= 0.5;
    freq *= 2.0;
  }
  return n;
}

// Multi-octave foam noise - blends Worley, ridged, and value noise for angular, sharp foam
float foamNoise(vec2 uv, float time) {
  // Worley noise for angular cell boundaries (sharp edges)
  vec2 worley = worleyNoise(uv * 0.5 + time * 0.008);
  float cellEdge = smoothstep(0.02, 0.12, worley.y); // Sharp at cell edges

  // Ridged noise for sharp streak/crease patterns
  float ridged = ridgedNoise(uv * 0.7, time);

  // Original value noise for organic variation
  float value = valueNoise(uv * 1.0 + time * 0.02) * 0.5 +
                valueNoise(uv * 2.0 - time * 0.015) * 0.35;

  // Blend: Worley edges provide angular structure, ridged adds sharp lines
  // Value noise breaks up uniformity
  float sharp = cellEdge * ridged;
  return mix(value, sharp, 0.55);
}

// Calculate foam amount based on wave height, slope, and noise
float calculateFoam(float height, float gradientMag, vec2 worldPos, float time) {
  // Height-based foam (wave peaks)
  float heightFoam = smoothstep(u_foamThreshold, u_foamThreshold + 0.15, height);

  // Slope-based foam (steep surfaces = breaking waves)
  float slopeFoam = smoothstep(0.3, 0.7, gradientMag);

  float baseFoam = max(heightFoam, slopeFoam * 0.4);

  // Noise breakup for patchy appearance
  float noise = foamNoise(worldPos * 0.12, time);

  float threshold = 1.0 - u_foamCoverage;
  float foamMask = smoothstep(threshold - 0.1, threshold + 0.1, noise);

  // Final foam with sharpness control
  float foam = baseFoam * foamMask * u_foamIntensity;
  foam = pow(clamp(foam, 0.0, 1.0), 1.0 / u_foamSharpness);

  return clamp(foam, 0.0, 1.0);
}

void main(void) {
  // Convert clip space (-1,1) to screen coords (0, screenSize)
  vec2 screenPos = (v_position * 0.5 + 0.5) * u_screenSize;

  // Transform screen position to world position using camera matrix
  vec3 worldPosH = u_cameraMatrix * vec3(screenPos, 1.0);
  vec2 worldPos = worldPosH.xy;

  // Map world position to data texture UV coordinates
  vec2 dataUV = (worldPos - u_viewportBounds.xy) / u_viewportBounds.zw;
  dataUV = clamp(dataUV, 0.0, 1.0);

  // Sample the data texture (values are packed as 0-255 -> 0.0-1.0)
  vec4 waterData = texture(u_waterData, dataUV);

  // Unpack height: 0.5 (127) is neutral, below is trough, above is peak
  float rawHeight = waterData.r;

  // Debug mode: height mapped to blue gradient with clipping indicators
  if (u_renderMode == 1) {
    vec3 debugColor;
    if (rawHeight < 0.02) {
      debugColor = vec3(1.0, 0.0, 0.0);  // Red for min clipping
    } else if (rawHeight > 0.98) {
      debugColor = vec3(1.0, 0.0, 0.0);  // Red for max clipping
    } else {
      // Blue gradient: dark blue (low) to light blue (high)
      vec3 darkBlue = vec3(0.0, 0.1, 0.3);
      vec3 lightBlue = vec3(0.6, 0.85, 1.0);
      debugColor = mix(darkBlue, lightBlue, rawHeight);
    }
    fragColor = vec4(debugColor, 1.0);
    return;
  }

  // Compute surface normal from height gradients
  float texelSize = 1.0 / ${WATER_TEXTURE_SIZE}.0;
  float heightL = texture(u_waterData, dataUV + vec2(-texelSize, 0.0)).r;
  float heightR = texture(u_waterData, dataUV + vec2(texelSize, 0.0)).r;
  float heightD = texture(u_waterData, dataUV + vec2(0.0, -texelSize)).r;
  float heightU = texture(u_waterData, dataUV + vec2(0.0, texelSize)).r;

  float heightScale = 3.0;
  vec3 normal = normalize(vec3(
    (heightL - heightR) * heightScale,
    (heightD - heightU) * heightScale,
    1.0
  ));

  // Store gradient magnitude for foam calculation
  float gradientMag = length(normal.xy);

  // Fixed midday sun
  vec3 sunDir = normalize(vec3(0.3, 0.2, 0.9));

  // Water colors - bluer and more cyan
  vec3 deepColor = vec3(0.08, 0.32, 0.52);      // Rich blue
  vec3 shallowColor = vec3(0.15, 0.50, 0.62);   // Bright cyan-blue
  vec3 scatterColor = vec3(0.1, 0.45, 0.55);    // Cyan scatter
  vec3 baseColor = mix(deepColor, shallowColor, rawHeight);

  // Slope-based color variation (subtle)
  float sunFacing = dot(normal.xy, sunDir.xy);
  vec3 slopeShift = mix(vec3(-0.02, -0.01, 0.02), vec3(0.02, 0.03, -0.01), sunFacing * 0.5 + 0.5);

  // Apply subtle color variation
  baseColor = baseColor + slopeShift * 0.08;

  // Troughs are darker and more saturated
  float troughDarken = (1.0 - rawHeight) * 0.12;
  baseColor *= (1.0 - troughDarken);

  // Sun and sky colors
  vec3 sunColor = vec3(1.0, 0.95, 0.85);
  vec3 skyColor = vec3(0.5, 0.7, 0.95);

  // View direction (looking straight down)
  vec3 viewDir = vec3(0.0, 0.0, 1.0);

  // Fresnel effect - very subtle
  float facing = dot(normal, viewDir);
  float fresnel = pow(1.0 - facing, 4.0) * 0.15;

  // Subsurface scattering - very subtle
  float scatter = max(dot(normal, sunDir), 0.0) * (0.5 + 0.5 * rawHeight);
  vec3 subsurface = scatterColor * scatter * 0.1;

  // Diffuse lighting - subtle
  float diffuse = max(dot(normal, sunDir), 0.0);

  // Specular - very reduced
  vec3 reflectDir = reflect(-sunDir, normal);
  float specular = pow(max(dot(viewDir, reflectDir), 0.0), 64.0); // Higher power = tighter highlights

  // Combine lighting - much more ambient, less dramatic
  vec3 ambient = baseColor * 0.75;
  vec3 diffuseLight = baseColor * sunColor * diffuse * 0.15;
  vec3 skyReflection = skyColor * fresnel * 0.1;
  vec3 specularLight = sunColor * specular * 0.08;

  vec3 color = ambient + subsurface + diffuseLight + skyReflection + specularLight;

  // Add high-frequency noise to break up smoothness
  float fineNoise = hash21(worldPos * 2.0) * 0.02 - 0.01;
  color += fineNoise;

  // Foam disabled while working on wave improvements
  // float textureFoam = waterData.a;
  // float detailFoam = calculateFoam(rawHeight, gradientMag, worldPos, u_time);
  // float foam = max(textureFoam * 0.85, detailFoam * 0.6) + textureFoam * detailFoam * 0.25;
  // foam = clamp(foam, 0.0, 1.0);
  // vec3 foamColor = vec3(0.92, 0.95, 0.98);
  // color = mix(color, foamColor, foam * 0.85);

  fragColor = vec4(color, 1.0);
}
`;

/**
 * Water shader using the FullscreenShader base class.
 */
export class WaterShader extends FullscreenShader {
  constructor(gl: WebGL2RenderingContext) {
    super(gl, {
      vertexSource: WATER_VERTEX_SHADER,
      fragmentSource: WATER_FRAGMENT_SHADER,
      uniforms: {
        u_cameraMatrix: { type: "mat3", value: new Float32Array(9) },
        u_time: { type: "1f", value: 0 },
        u_renderMode: { type: "1i", value: 0 },
        u_screenSize: { type: "2f", value: [800, 600] },
        u_viewportBounds: { type: "4f", value: [0, 0, 100, 100] },
        u_foamThreshold: { type: "1f", value: 0.7 },
        u_foamIntensity: { type: "1f", value: 0.5 },
        u_foamCoverage: { type: "1f", value: 0.3 },
        u_foamSharpness: { type: "1f", value: 2.0 },
        u_colorNoiseStrength: { type: "1f", value: 0.1 },
      },
      textures: ["u_waterData"],
    });
  }

  setCameraMatrix(matrix: Float32Array): void {
    this.uniforms.u_cameraMatrix.value.set(matrix);
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

  setTime(time: number): void {
    this.uniforms.u_time.value = time;
  }

  setRenderMode(mode: number): void {
    this.uniforms.u_renderMode.value = mode;
  }

  setScreenSize(width: number, height: number): void {
    this.uniforms.u_screenSize.value[0] = width;
    this.uniforms.u_screenSize.value[1] = height;
  }

  setFoamThreshold(value: number): void {
    this.uniforms.u_foamThreshold.value = value;
  }

  setFoamIntensity(value: number): void {
    this.uniforms.u_foamIntensity.value = value;
  }

  setFoamCoverage(value: number): void {
    this.uniforms.u_foamCoverage.value = value;
  }

  setFoamSharpness(value: number): void {
    this.uniforms.u_foamSharpness.value = value;
  }

  setColorNoiseStrength(value: number): void {
    this.uniforms.u_colorNoiseStrength.value = value;
  }

  renderWater(waterDataTexture: WebGLTexture | null): void {
    this.render({ u_waterData: waterDataTexture });
  }
}
