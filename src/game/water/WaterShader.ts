import { defaultFilterVert, Filter, GlProgram, Texture } from "pixi.js";

const fragment = /*glsl*/ `
  precision highp float;

  in vec2 vTextureCoord;

  uniform sampler2D uTexture;
  uniform vec4 uInputSize;
  uniform vec4 uOutputFrame;

  uniform mat3 uCameraMatrix;
  uniform float uResolution;
  uniform float uTime;
  uniform vec4 uViewportBounds;  // [left, top, width, height] in world space
  uniform sampler2D uWaterData;  // 512x512 data texture with height/velocity
  uniform int uRenderMode;  // 0 = realistic, 1 = debug height

  const float PI = 3.14159265359;

  void main(void) {
    vec2 screenPos = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
    vec2 worldPos = (uCameraMatrix * vec3(screenPos, 1.0)).xy / uResolution;

    // Map world position to data texture UV coordinates
    vec2 dataUV = (worldPos - uViewportBounds.xy) / uViewportBounds.zw;
    dataUV = clamp(dataUV, 0.0, 1.0);

    // Sample the data texture (values are packed as 0-255 -> 0.0-1.0)
    vec4 waterData = texture(uWaterData, dataUV);

    // Unpack height: 0.5 (127) is neutral, below is trough, above is peak
    float rawHeight = waterData.r;

    // Debug mode: height mapped to blue gradient with clipping indicators
    if (uRenderMode == 1) {
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
      gl_FragColor = vec4(debugColor, 1.0);
      return;
    }

    // Compute surface normal from height gradients
    float texelSize = 1.0 / 512.0;
    float heightL = texture(uWaterData, dataUV + vec2(-texelSize, 0.0)).r;
    float heightR = texture(uWaterData, dataUV + vec2(texelSize, 0.0)).r;
    float heightD = texture(uWaterData, dataUV + vec2(0.0, -texelSize)).r;
    float heightU = texture(uWaterData, dataUV + vec2(0.0, texelSize)).r;

    float heightScale = 8.0;
    vec3 normal = normalize(vec3(
      (heightL - heightR) * heightScale,
      (heightD - heightU) * heightScale,
      1.0
    ));

    // Dynamic sun position based on time (120 second day cycle)
    float dayLength = 120.0;
    float sunAngle = uTime * (2.0 * PI / dayLength);
    float sunElevation = 0.5 + 0.4 * sin(sunAngle);
    vec3 sunDir = normalize(vec3(
      cos(sunAngle),
      sin(sunAngle) * 0.3,
      sunElevation
    ));

    // Water colors
    vec3 deepColor = vec3(0.01, 0.05, 0.15);      // Deep ocean blue
    vec3 shallowColor = vec3(0.02, 0.12, 0.28);   // Shallower blue
    vec3 scatterColor = vec3(0.0, 0.25, 0.22);    // Subsurface scattering (teal/green)
    vec3 baseColor = mix(deepColor, shallowColor, rawHeight);

    // Sun and sky colors
    vec3 sunColor = vec3(1.0, 0.95, 0.85);
    vec3 skyColor = vec3(0.5, 0.7, 0.95);

    // View direction (looking straight down)
    vec3 viewDir = vec3(0.0, 0.0, 1.0);

    // Fresnel effect - tilted surfaces reflect more sky
    float facing = dot(normal, viewDir);
    float fresnel = pow(1.0 - facing, 3.0);

    // Subsurface scattering - light passing through wave peaks
    float scatter = max(dot(normal, sunDir), 0.0) * (0.5 + 0.5 * rawHeight);
    vec3 subsurface = scatterColor * scatter * 0.6;

    // Diffuse lighting
    float diffuse = max(dot(normal, sunDir), 0.0);

    // Specular lighting
    vec3 reflectDir = reflect(-sunDir, normal);
    float specular = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);

    // Combine lighting
    vec3 ambient = baseColor * 0.4;
    vec3 diffuseLight = baseColor * sunColor * diffuse * 0.4;
    vec3 skyReflection = skyColor * fresnel * 0.5;
    vec3 specularLight = sunColor * specular * 0.6;

    vec3 color = ambient + subsurface + diffuseLight + skyReflection + specularLight;

    gl_FragColor = vec4(color, 1.0);
  }

  /*
  // Quantized color palette (commented out for now)
  // 6-level color palette for vector art style
  vec3 darkBlue = vec3(0.02, 0.08, 0.20);       // deep troughs
  vec3 darkMedBlue = vec3(0.05, 0.14, 0.32);    // shallow troughs
  vec3 mediumBlue = vec3(0.08, 0.20, 0.45);     // normal
  vec3 medLightBlue = vec3(0.16, 0.35, 0.58);   // slightly elevated
  vec3 lightBlue = vec3(0.25, 0.50, 0.70);      // elevated
  vec3 white = vec3(0.85, 0.92, 0.98);          // peaks

  float relativeHeight = (rawHeight - 0.5) * 2.0; // -1 to +1 range

  // Quantize to 6 levels based on height
  vec3 color;
  if (relativeHeight < -0.3) {
    color = darkBlue;       // deep trough
  } else if (relativeHeight < -0.1) {
    color = darkMedBlue;    // shallow trough
  } else if (relativeHeight < 0.1) {
    color = mediumBlue;     // normal
  } else if (relativeHeight < 0.3) {
    color = medLightBlue;   // slightly elevated
  } else if (relativeHeight < 0.5) {
    color = lightBlue;      // elevated
  } else {
    color = white;          // peak
  }
  */
`;

/**
 * Create a water shader filter.
 */
export function createWaterShader(waterDataTexture?: Texture): Filter {
  return new Filter({
    glProgram: new GlProgram({ fragment, vertex: defaultFilterVert }),
    resources: {
      waterUniforms: {
        uResolution: { value: 1, type: "f32" },
        uTime: { value: 0, type: "f32" },
        uRenderMode: { value: 0, type: "i32" },
        uCameraMatrix: {
          value: new Float32Array(9),
          type: "mat3x3<f32>",
        },
        uViewportBounds: {
          value: new Float32Array(4),
          type: "vec4<f32>",
        },
      },
      uWaterData: (waterDataTexture ?? Texture.WHITE).source,
    },
  });
}
