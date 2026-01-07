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
  uniform sampler2D uWaterData;  // 64x64 data texture with height/velocity

  void main(void) {
    vec2 screenPos = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
    vec2 worldPos = (uCameraMatrix * vec3(screenPos, 1.0)).xy / uResolution;

    // Map world position to data texture UV coordinates
    vec2 dataUV = (worldPos - uViewportBounds.xy) / uViewportBounds.zw;
    dataUV = clamp(dataUV, 0.0, 1.0);

    // Sample the data texture (values are packed as 0-255 -> 0.0-1.0)
    vec4 waterData = texture(uWaterData, dataUV);

    // Unpack height: texture R channel (0-1 maps to 0-5 world units)
    float surfaceHeight = waterData.r * 5.0;

    // Normalize height for color mixing
    float h = clamp(surfaceHeight / 3.0, 0.0, 1.0);

    // Color palette based on height
    vec3 deepBlue = vec3(0.05, 0.15, 0.35);
    vec3 lightBlue = vec3(0.3, 0.55, 0.75);

    // Mix based on height
    vec3 color = mix(deepBlue, lightBlue, h);

    gl_FragColor = vec4(color, 1.0);
  }
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
