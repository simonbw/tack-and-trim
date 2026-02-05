/**
 * Test file to verify the shader module system works correctly.
 * This file demonstrates module composition and can be used for testing.
 *
 * DO NOT IMPORT THIS IN PRODUCTION CODE - IT'S JUST FOR TESTING.
 */

import {
  ComputeShader,
  type ComputeShaderConfig,
} from "../../../core/graphics/webgpu/ComputeShader";
import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { struct_QueryPoint } from "./common.wgsl";
import { fn_calculateWaterData } from "./water.wgsl";

const WORKGROUP_SIZE = [64, 1] as const;

/**
 * Module containing test-specific structs and bindings.
 */
const testBindingsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Result {
  waterData: vec4<f32>,
}
  `,
  bindings: {
    // queryPoints from queryPointsModule
    queryPoints: { type: "storage", wgslType: "array<QueryPoint>" },
    // terrainContours and controlPoints from terrainHeightModule (via waterDataModule dependency)
    terrainContours: { type: "storage", wgslType: "array<ContourData>" },
    controlPoints: { type: "storage", wgslType: "array<vec2<f32>>" },
    // waveSources and waterParams from waterDataModule
    waveSources: { type: "storage", wgslType: "array<WaveSource>" },
    waterParams: { type: "uniform", wgslType: "WaterParams" },
    // Additional binding for output
    results: { type: "storageRW", wgslType: "array<Result>" },
  },
  code: "",
};

/**
 * Module containing the test compute entry point.
 */
const testMainModule: ShaderModule = {
  dependencies: [struct_QueryPoint, fn_calculateWaterData, testBindingsModule],
  code: /*wgsl*/ `
@compute @workgroup_size(${WORKGROUP_SIZE[0]}, ${WORKGROUP_SIZE[1]})
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let idx = globalId.x;
  if (idx >= arrayLength(&queryPoints)) {
    return;
  }

  // Use QueryPoint from queryPointsModule
  let queryPoint = queryPoints[idx];

  // Use calculateWaterData from waterDataModule
  // (which internally uses calculateTerrainHeight from terrainHeightModule)
  let waterData = calculateWaterData(queryPoint.pos);

  // Store result
  results[idx].waterData = waterData;
}
  `,
};

/**
 * Configuration for the test module system shader.
 */
export const testModuleSystemShaderConfig: ComputeShaderConfig = {
  modules: [testMainModule],
  workgroupSize: WORKGROUP_SIZE,
  label: "TestModuleSystemShader",
};

/**
 * Create a test module system compute shader instance.
 */
export function createTestModuleSystemShader(): ComputeShader {
  return new ComputeShader(testModuleSystemShaderConfig);
}
