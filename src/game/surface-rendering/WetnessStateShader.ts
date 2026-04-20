/**
 * Wetness state compute shader.
 *
 * Computes sand wetness over time based on water depth.
 * Uses ping-pong textures with reprojection to persist wetness
 * as the camera moves.
 *
 * Output format (r32float):
 * - R: Wetness value (0 = dry, 1 = fully wet)
 */

import {
  defineUniformStruct,
  f32,
  mat3x3,
} from "../../core/graphics/UniformStruct";
import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";

// Wetness rates (configurable defaults)
const DEFAULT_WETTING_RATE = 5.0; // Reach full wet in ~0.25 seconds
const DEFAULT_DRYING_RATE = 0.05; // Reach fully dry in ~20 seconds

const WORKGROUP_SIZE = [8, 8] as const;

/**
 * Uniform struct for wetness state parameters.
 *
 * The wetness, water-height, and terrain-height textures all share the same
 * screen-aligned expanded-viewport layout, so sampling water/terrain at the
 * current texel is a direct UV read — no matrix math needed.
 *
 * Reprojection still requires two matrices: current clip→world to find the
 * current texel's world position, and previous world→clip to find where that
 * world position lived in the prior frame's wetness texture.
 */
export const WetnessUniforms = defineUniformStruct("Params", {
  currentTexClipToWorld: mat3x3,
  prevWorldToTexClip: mat3x3,
  dt: f32,
  wettingRate: f32,
  dryingRate: f32,
  textureSizeX: f32,
  textureSizeY: f32,
});

/**
 * Module containing Params struct and bindings.
 */
const wetnessParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Params {
  currentTexClipToWorld: mat3x3<f32>,
  prevWorldToTexClip: mat3x3<f32>,
  dt: f32,
  wettingRate: f32,
  dryingRate: f32,
  textureSizeX: f32,
  textureSizeY: f32,
}
  `,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    prevWetnessTexture: { type: "texture" },
    waterTexture: { type: "texture" },
    terrainTexture: { type: "texture" },
    textureSampler: { type: "sampler" },
    outputTexture: { type: "storageTexture", format: "r32float" },
  },
  code: "",
};

/**
 * Module containing the compute entry point.
 */
const wetnessMainModule: ShaderModule = {
  dependencies: [wetnessParamsModule],
  code: /*wgsl*/ `
// Constants
const DEFAULT_WETTING_RATE: f32 = ${DEFAULT_WETTING_RATE};
const DEFAULT_DRYING_RATE: f32 = ${DEFAULT_DRYING_RATE};

@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSizeX = params.textureSizeX;
  let texSizeY = params.textureSizeY;

  if (f32(globalId.x) >= texSizeX || f32(globalId.y) >= texSizeY) {
    return;
  }

  // Current texel UV (shared with water/terrain textures — same layout).
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / vec2<f32>(texSizeX, texSizeY);

  // World position for this texel (needed for reprojection into the
  // previous frame's wetness texture).
  let clip = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let worldPos = (params.currentTexClipToWorld * vec3<f32>(clip, 1.0)).xy;

  // Reproject to previous wetness texture UV.
  let prevClip = (params.prevWorldToTexClip * vec3<f32>(worldPos, 1.0)).xy;
  let prevUV = vec2<f32>((prevClip.x + 1.0) * 0.5, (1.0 - prevClip.y) * 0.5);

  // Water and terrain textures share this texel's UV (same layout).
  let waterData = textureSampleLevel(waterTexture, textureSampler, uv, 0.0);
  let terrainData = textureSampleLevel(terrainTexture, textureSampler, uv, 0.0);

  // Compute water depth
  let waterSurfaceHeight = waterData.r;
  let terrainHeight = terrainData.r;
  let waterDepth = waterSurfaceHeight - terrainHeight;

  // Get previous wetness with reprojection
  var prevWetness: f32;
  let inBounds = prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0;
  if (inBounds) {
    prevWetness = textureSampleLevel(prevWetnessTexture, textureSampler, prevUV, 0.0).r;
  } else {
    // New area entering viewport - initialize based on current water depth
    if (waterDepth > 0.0) {
      prevWetness = 1.0;  // Underwater = wet
    } else {
      prevWetness = 0.0;  // Exposed = dry
    }
  }

  // Update wetness based on water depth
  var newWetness: f32;
  if (waterDepth > 0.0) {
    // Underwater - rapidly wet (reach 1.0 based on wetting rate)
    newWetness = min(1.0, prevWetness + params.wettingRate * params.dt);
  } else {
    // Exposed - slowly dry (reach 0.0 based on drying rate)
    newWetness = max(0.0, prevWetness - params.dryingRate * params.dt);
  }

  // Write output (sharpening applied in display shader, not here)
  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(newWetness, 0.0, 0.0, 1.0));
}
  `,
};

/**
 * Configuration for the wetness state shader.
 */
export const wetnessStateShaderConfig: ComputeShaderConfig = {
  modules: [wetnessMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "WetnessStateShader",
};

/**
 * Create a wetness state compute shader instance.
 */
export function createWetnessStateShader(): ComputeShader {
  return new ComputeShader(wetnessStateShaderConfig);
}

// Export constants for use in pipeline
export { DEFAULT_DRYING_RATE, DEFAULT_WETTING_RATE };
