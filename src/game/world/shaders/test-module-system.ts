/**
 * Test file to verify the shader module system works correctly.
 * This file demonstrates module composition and can be used for testing.
 *
 * DO NOT IMPORT THIS IN PRODUCTION CODE - IT'S JUST FOR TESTING.
 */

import { ComputeShader } from "../../../core/graphics/webgpu/ComputeShader";
import { queryPointsModule } from "./common.wgsl";
import { waterDataModule } from "./water.wgsl";

// Test bindings combining module bindings with additional ones
const testBindings = {
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
} as const;

/**
 * Test compute shader using the module system.
 * Demonstrates:
 * - Module composition
 * - Dependency resolution (waterDataModule depends on terrainHeightModule)
 * - Binding merging
 */
export class TestModuleSystemShader extends ComputeShader<typeof testBindings> {
  // Use modules instead of direct code
  protected modules = [queryPointsModule, waterDataModule];

  // Main compute code that uses functions from modules
  protected mainCode = /*wgsl*/ `
    struct Result {
      waterData: vec4<f32>,
    }

    ${this.buildWGSLBindings()}

    @compute @workgroup_size(64, 1)
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
  `;

  readonly bindings = testBindings;
  readonly workgroupSize = [64, 1] as const;
}
