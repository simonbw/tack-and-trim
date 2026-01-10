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
uniform sampler2D u_waterData;  // Wave data texture with height
uniform sampler2D u_modifierData;  // Modifier texture (wakes, etc.)
uniform int u_renderMode;       // 0 = realistic, 1 = debug height

// Color variation uniforms
uniform float u_colorNoiseStrength;

const float PI = 3.14159265359;

// Hash function for procedural noise - scalar output
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
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
  vec4 modifierData = texture(u_modifierData, dataUV);

  // Unpack height: 0.5 (127) is neutral, below is trough, above is peak
  // Wave height from GPU-computed Gerstner waves
  float waveHeight = waterData.r;
  // Modifier height contribution (wakes, etc.) - 0.5 is neutral
  float modifierHeight = modifierData.r - 0.5;
  // Combined height
  float rawHeight = waveHeight + modifierHeight;

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
        u_colorNoiseStrength: { type: "1f", value: 0.1 },
      },
      textures: ["u_waterData", "u_modifierData"],
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

  setColorNoiseStrength(value: number): void {
    this.uniforms.u_colorNoiseStrength.value = value;
  }

  renderWater(
    waterDataTexture: WebGLTexture | null,
    modifierDataTexture: WebGLTexture | null,
  ): void {
    this.render({
      u_waterData: waterDataTexture,
      u_modifierData: modifierDataTexture,
    });
  }
}
