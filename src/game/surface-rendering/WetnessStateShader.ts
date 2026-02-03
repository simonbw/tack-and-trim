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

import { ComputeShader } from "../../core/graphics/webgpu/ComputeShader";
import { viewportModule } from "../world/shaders/coordinates.wgsl";
import { WATER_HEIGHT_SCALE } from "../world-data/water/WaterConstants";

// Wetness rates (configurable defaults)
const DEFAULT_WETTING_RATE = 4.0; // Reach full wet in ~0.25 seconds
const DEFAULT_DRYING_RATE = 0.15; // Dry in ~6-7 seconds

const bindings = {
  params: { type: "uniform", wgslType: "Params" },
  prevWetnessTexture: { type: "texture" },
  waterTexture: { type: "texture" },
  terrainTexture: { type: "texture" },
  textureSampler: { type: "sampler" },
  outputTexture: { type: "storageTexture", format: "r32float" },
} as const;

/**
 * Wetness state compute shader using the ComputeShader base class.
 */
export class WetnessStateShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8] as const;

  protected modules = [viewportModule];

  protected mainCode = /*wgsl*/ `
    // ============================================================================
    // Constants
    // ============================================================================
    const WATER_HEIGHT_SCALE: f32 = ${WATER_HEIGHT_SCALE};
    const DEFAULT_WETTING_RATE: f32 = ${DEFAULT_WETTING_RATE};
    const DEFAULT_DRYING_RATE: f32 = ${DEFAULT_DRYING_RATE};

    // ============================================================================
    // Uniforms and Bindings
    // ============================================================================
    struct Params {
      // Delta time
      dt: f32,
      // Wetness change rates
      wettingRate: f32,
      dryingRate: f32,
      // Texture dimensions
      textureSizeX: f32,
      textureSizeY: f32,
      // Current wetness viewport (left, top, width, height)
      currentViewportLeft: f32,
      currentViewportTop: f32,
      currentViewportWidth: f32,
      currentViewportHeight: f32,
      // Previous wetness viewport for reprojection
      prevViewportLeft: f32,
      prevViewportTop: f32,
      prevViewportWidth: f32,
      prevViewportHeight: f32,
      // Render viewport (for sampling water/terrain textures)
      renderViewportLeft: f32,
      renderViewportTop: f32,
      renderViewportWidth: f32,
      renderViewportHeight: f32,
    }

    ${this.buildWGSLBindings()}

    // ============================================================================
    // Main
    // ============================================================================

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
      let texSizeX = params.textureSizeX;
      let texSizeY = params.textureSizeY;

      if (f32(globalId.x) >= texSizeX || f32(globalId.y) >= texSizeY) {
        return;
      }

      // Convert texel to UV in current viewport
      let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / vec2<f32>(texSizeX, texSizeY);

      // Convert to world position using current wetness viewport (from module)
      let worldPos = uvToWorld(
        uv,
        params.currentViewportLeft,
        params.currentViewportTop,
        params.currentViewportWidth,
        params.currentViewportHeight
      );

      // Convert world position to UV in previous wetness viewport for reprojection (from module)
      let prevUV = worldToUV(
        worldPos,
        params.prevViewportLeft,
        params.prevViewportTop,
        params.prevViewportWidth,
        params.prevViewportHeight
      );

      // Convert world position to UV in render viewport for sampling water/terrain (from module)
      // (water and terrain textures use a different viewport than wetness)
      let renderUV = worldToUV(
        worldPos,
        params.renderViewportLeft,
        params.renderViewportTop,
        params.renderViewportWidth,
        params.renderViewportHeight
      );

      // Sample water and terrain textures at render viewport UV
      let waterData = textureSampleLevel(waterTexture, textureSampler, renderUV, 0.0);
      let terrainData = textureSampleLevel(terrainTexture, textureSampler, renderUV, 0.0);

      // Compute water depth
      let waterSurfaceHeight = (waterData.r - 0.5) * WATER_HEIGHT_SCALE;
      let terrainHeight = terrainData.r;
      let waterDepth = waterSurfaceHeight - terrainHeight;

      // Get previous wetness with reprojection
      var prevWetness: f32;
      if (uvInBounds(prevUV)) { // uvInBounds from module
        // Sample from previous frame at the reprojected UV
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
  `;
}

// Export constants for use in pipeline
export { DEFAULT_WETTING_RATE, DEFAULT_DRYING_RATE };
