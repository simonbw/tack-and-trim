/**
 * Wind state compute shader.
 *
 * Extends ComputeShader base class to compute wind velocity field.
 * Implements base wind velocity with simplex noise variation.
 *
 * Output format (rg32float):
 * - R: Normalized velocity X (velocityX / WIND_VELOCITY_SCALE + 0.5)
 * - G: Normalized velocity Y (velocityY / WIND_VELOCITY_SCALE + 0.5)
 */

import { ComputeShader } from "../../../../core/graphics/webgpu/ComputeShader";
import { windVelocityModule } from "../../../world/shaders/wind.wgsl";
import { viewportModule } from "../../../world/shaders/coordinates.wgsl";
import {
  WIND_ANGLE_VARIATION,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_NOISE_TIME_SCALE,
  WIND_SPEED_VARIATION,
  WIND_VELOCITY_SCALE,
} from "../WindConstants";
import { WindParams } from "./WindParams";

const bindings = {
  params: { type: "uniform", wgslType: "Params" },
  outputTexture: { type: "storageTexture", format: "rg32float" },
} as const;

/**
 * Wind state compute shader using the ComputeShader base class.
 */
export class WindStateShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8] as const;

  protected modules = [windVelocityModule, viewportModule];

  protected mainCode = /*wgsl*/ `
    // Constants
    const WIND_NOISE_SPATIAL_SCALE: f32 = ${WIND_NOISE_SPATIAL_SCALE};
    const WIND_NOISE_TIME_SCALE: f32 = ${WIND_NOISE_TIME_SCALE};
    const WIND_SPEED_VARIATION: f32 = ${WIND_SPEED_VARIATION};
    const WIND_ANGLE_VARIATION: f32 = ${WIND_ANGLE_VARIATION};
    const WIND_VELOCITY_SCALE: f32 = ${WIND_VELOCITY_SCALE};

    ${WindParams.wgsl}

    ${this.buildWGSLBindings()}

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
      let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);

      // Check bounds
      if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
        return;
      }

      // Convert pixel coords to UV (0-1)
      let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) / texSize;

      // Map UV to world position using viewport module
      let worldPos = uvToWorld(
        uv,
        params.viewportLeft,
        params.viewportTop,
        params.viewportWidth,
        params.viewportHeight
      );

      // Calculate wind velocity using wind module
      let velocity = calculateWindVelocity(
        worldPos,
        params.time,
        params.baseWind,
        params.influenceSpeedFactor,
        params.influenceDirectionOffset,
        params.influenceTurbulence,
        WIND_NOISE_SPATIAL_SCALE,
        WIND_NOISE_TIME_SCALE,
        WIND_SPEED_VARIATION,
        WIND_ANGLE_VARIATION
      );

      // Normalize output to 0-1 range
      let normalizedVel = velocity / WIND_VELOCITY_SCALE + vec2<f32>(0.5, 0.5);

      textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalizedVel.x, normalizedVel.y, 0.0, 0.0));
    }
  `;
}
