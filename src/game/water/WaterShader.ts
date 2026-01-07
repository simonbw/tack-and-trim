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

    // Unpack height: 0.5 (127) is neutral, below is trough, above is peak
    float rawHeight = waterData.r;
    float relativeHeight = (rawHeight - 0.5) * 2.0; // -1 to +1 range

    // 4-level color palette for vector art style
    vec3 darkBlue = vec3(0.02, 0.08, 0.20);    // troughs (low)
    vec3 mediumBlue = vec3(0.08, 0.20, 0.45);  // normal
    vec3 lightBlue = vec3(0.25, 0.50, 0.70);   // elevated
    vec3 white = vec3(0.85, 0.92, 0.98);       // peaks

    // Quantize to 4 levels based on height
    vec3 color;
    if (relativeHeight < -0.15) {
      color = darkBlue;      // trough
    } else if (relativeHeight < 0.15) {
      color = mediumBlue;    // normal
    } else if (relativeHeight < 0.5) {
      color = lightBlue;     // elevated
    } else {
      color = white;         // peak
    }

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
