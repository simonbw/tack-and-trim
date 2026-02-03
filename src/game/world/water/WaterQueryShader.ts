/**
 * Water Query Compute Shader
 *
 * Samples water data (height, velocity, normals, depth) at arbitrary query points.
 * Uses the same modular shader code as the water state shader.
 *
 * Input:  pointBuffer (storage) - array of vec2<f32> query points
 * Output: resultBuffer (storage) - array of WaterQueryResult structs
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";

const bindings = {
  params: { type: "uniform", wgslType: "Params" },
  pointBuffer: { type: "storage", wgslType: "array<vec2<f32>>" },
  resultBuffer: { type: "storageRW", wgslType: "array<WaterQueryResult>" },
} as const;

/**
 * Water query compute shader.
 * Computes water state at provided query points using analytical wave physics.
 *
 * TODO: Integrate full wave computation using gerstnerWaveModule, modifierCompositionModule, etc.
 * For now, returns placeholder data to get the infrastructure working.
 */
export class WaterQueryShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [64, 1, 1] as const;

  protected mainCode = /*wgsl*/ `
// Query parameters
struct Params {
  pointCount: u32,
  time: f32,
}

// Result structure (matches WaterQueryResult interface)
// stride = 6 floats
struct WaterQueryResult {
  surfaceHeight: f32,
  velocityX: f32,
  velocityY: f32,
  normalX: f32,
  normalY: f32,
  depth: f32,
}

${this.buildWGSLBindings()}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let index = globalId.x;

  if (index >= params.pointCount) {
    return;
  }

  let queryPoint = pointBuffer[index];

  // TODO: Compute actual water state using wave modules
  // For now, return simple placeholder data
  var result: WaterQueryResult;
  result.surfaceHeight = sin(queryPoint.x * 0.01 + params.time) * 0.5;
  result.velocityX = 0.0;
  result.velocityY = 0.0;
  result.normalX = 0.0;
  result.normalY = 1.0;
  result.depth = 100.0; // Deep water placeholder

  resultBuffer[index] = result;
}
`;
}
