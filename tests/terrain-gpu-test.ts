/**
 * Terrain GPU correctness test.
 *
 * Validates that the GPU terrain height computation matches Rust reference data,
 * and that the IDW grid optimization produces identical results to the fallback path.
 *
 * Usage:
 *   npx tsx tests/terrain-gpu-test.ts
 *
 * Prerequisites:
 *   1. Generate reference data:
 *      cargo run -p terrain-core --bin generate-terrain-reference -- \
 *        resources/levels/default.level.json tests/fixtures/default-terrain-reference.json
 *   2. Install webgpu package: npm install --save-dev webgpu
 */

import * as fs from "fs";
import * as path from "path";

// Dawn-based WebGPU for Node.js
import { create, globals } from "webgpu";
Object.assign(globalThis, globals);

// Shader assembly (no GPU device needed at import time)
import { assembleComputeShaderWGSL } from "../src/core/graphics/webgpu/ComputeShader";
import { terrainQueryShaderConfig } from "../src/game/world/terrain/TerrainQueryShader";

// Terrain data building (pure functions, no GPU needed)
import {
  levelFileToTerrainDefinition,
  validateLevelFile,
} from "../src/editor/io/LevelFileFormat";
import {
  buildTerrainGPUData,
  FLOATS_PER_CONTOUR,
} from "../src/game/world/terrain/LandMass";
import { packTerrainBuffer } from "../src/game/world/terrain/TerrainResources";
import { DEFAULT_DEPTH } from "../src/game/world/terrain/TerrainConstants";

// ---------------------------------------------------------------------------
// Reference data types
// ---------------------------------------------------------------------------

interface ReferencePoint {
  x: number;
  y: number;
  height: number;
  gradientX: number;
  gradientY: number;
}

interface ReferenceData {
  level: string;
  defaultDepth: number;
  contourCount: number;
  points: ReferencePoint[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

function loadReferenceData(filePath: string): ReferenceData {
  const json = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(json) as ReferenceData;
}

function loadAndBuildTerrain(levelPath: string) {
  const json = fs.readFileSync(levelPath, "utf-8");
  const levelFile = validateLevelFile(JSON.parse(json));
  const definition = levelFileToTerrainDefinition(levelFile);
  const gpuData = buildTerrainGPUData(definition);
  const packed = packTerrainBuffer(gpuData);
  return {
    packed,
    contourCount: gpuData.contourCount,
    defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
  };
}

// ---------------------------------------------------------------------------
// GPU test runner
// ---------------------------------------------------------------------------

async function runTerrainGPUTest(
  device: GPUDevice,
  packedTerrain: Uint32Array,
  contourCount: number,
  defaultDepth: number,
  testPoints: Float32Array,
  pointCount: number,
): Promise<Float32Array> {
  // Assemble WGSL
  const wgsl = assembleComputeShaderWGSL(terrainQueryShaderConfig);

  // Create shader module
  const shaderModule = device.createShaderModule({
    code: wgsl,
    label: "Terrain Query Test Shader",
  });

  // Create pipeline with auto layout
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: shaderModule,
      entryPoint: "main",
    },
    label: "Terrain Query Test Pipeline",
  });

  // Create buffers
  // Uniform buffer: pointCount (u32), contourCount (u32), defaultDepth (f32), padding (f32)
  const uniformData = new ArrayBuffer(16);
  const uniformU32 = new Uint32Array(uniformData);
  const uniformF32 = new Float32Array(uniformData);
  uniformU32[0] = pointCount;
  uniformU32[1] = contourCount;
  uniformF32[2] = defaultDepth;
  uniformF32[3] = 0; // padding

  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "Params Uniform",
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  const pointBuffer = device.createBuffer({
    size: testPoints.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Point Buffer",
  });
  device.queue.writeBuffer(pointBuffer, 0, testPoints.buffer);

  // Result buffer: 4 floats per point (height, normalX, normalY, terrainType)
  const resultByteSize = pointCount * 4 * 4;
  const resultBuffer = device.createBuffer({
    size: resultByteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    label: "Result Buffer",
  });

  const readbackBuffer = device.createBuffer({
    size: resultByteSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: "Readback Buffer",
  });

  const terrainBuffer = device.createBuffer({
    size: packedTerrain.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: "Packed Terrain Buffer",
  });
  device.queue.writeBuffer(terrainBuffer, 0, packedTerrain.buffer);

  // Create bind group
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: pointBuffer } },
      { binding: 2, resource: { buffer: resultBuffer } },
      { binding: 3, resource: { buffer: terrainBuffer } },
    ],
    label: "Terrain Query Test Bind Group",
  });

  // Dispatch
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(pointCount / 64));
  pass.end();
  encoder.copyBufferToBuffer(
    resultBuffer,
    0,
    readbackBuffer,
    0,
    resultByteSize,
  );
  device.queue.submit([encoder.finish()]);

  // Read back
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Float32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  // Cleanup
  uniformBuffer.destroy();
  pointBuffer.destroy();
  resultBuffer.destroy();
  readbackBuffer.destroy();
  terrainBuffer.destroy();

  return resultData;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = path.resolve(__dirname, "..");

  // 1. Get WebGPU device via Dawn
  console.log("Initializing WebGPU (Dawn)...");
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Failed to get WebGPU adapter");
  }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  console.log(`  Adapter: ${adapter.info?.device ?? "unknown"}`);

  // 2. Load terrain data
  console.log("\nLoading terrain data...");
  const levelPath = path.join(
    projectRoot,
    "resources/levels/default.level.json",
  );
  const { packed, contourCount, defaultDepth } = loadAndBuildTerrain(levelPath);
  console.log(`  Contours: ${contourCount}, default depth: ${defaultDepth}`);
  console.log(
    `  Packed buffer: ${packed.length} u32s (${(packed.byteLength / 1024).toFixed(1)} KB)`,
  );

  // 3. Load reference data
  const refPath = path.join(
    projectRoot,
    "tests/fixtures/default-terrain-reference.json",
  );
  if (!fs.existsSync(refPath)) {
    console.error(`\nReference data not found: ${refPath}`);
    console.error("Generate it with:");
    console.error(
      "  cargo run -p terrain-core --bin generate-terrain-reference -- \\",
    );
    console.error(
      "    resources/levels/default.level.json tests/fixtures/default-terrain-reference.json",
    );
    process.exit(1);
  }
  const refData = loadReferenceData(refPath);
  console.log(`\nLoaded ${refData.points.length} reference points`);
  console.log(
    `  Reference contours: ${refData.contourCount}, default depth: ${refData.defaultDepth}`,
  );

  // 4. Prepare test points
  const pointCount = refData.points.length;
  const testPoints = new Float32Array(pointCount * 2);
  for (let i = 0; i < pointCount; i++) {
    testPoints[i * 2] = refData.points[i].x;
    testPoints[i * 2 + 1] = refData.points[i].y;
  }

  // =========================================================================
  // TEST A: GPU heights vs Rust reference
  // =========================================================================
  // Both use the IDW grid. Differences come from independent spline sampling
  // (TS vs Rust) and f32 vs f64 precision. This is a cross-implementation
  // sanity check, not an exact-match test.
  console.log("\n=== TEST A: GPU vs Rust Reference (cross-implementation) ===");
  const gpuResults = await runTerrainGPUTest(
    device,
    packed,
    contourCount,
    defaultDepth,
    testPoints,
    pointCount,
  );

  let maxDiff = 0;
  let sumDiff = 0;
  let countAbove001 = 0;
  let countAbove01 = 0;
  let countAbove1 = 0;
  let worstIdx = 0;

  for (let i = 0; i < pointCount; i++) {
    const gpuHeight = gpuResults[i * 4]; // height is first field
    const refHeight = refData.points[i].height;
    const diff = Math.abs(gpuHeight - refHeight);
    sumDiff += diff;
    if (diff > maxDiff) {
      maxDiff = diff;
      worstIdx = i;
    }
    if (diff > 0.01) countAbove001++;
    if (diff > 0.1) countAbove01++;
    if (diff > 1.0) countAbove1++;
  }

  const meanDiff = sumDiff / pointCount;
  console.log(`  Points tested:    ${pointCount}`);
  console.log(`  Max height diff:  ${maxDiff.toFixed(6)} ft`);
  console.log(`  Cumulative diff:  ${sumDiff.toFixed(6)} ft`);
  console.log(`  Mean diff:        ${meanDiff.toExponential(4)} ft`);
  console.log(
    `  Points > 0.01 ft: ${countAbove001} (${((100 * countAbove001) / pointCount).toFixed(2)}%)`,
  );
  console.log(
    `  Points > 0.1 ft:  ${countAbove01} (${((100 * countAbove01) / pointCount).toFixed(2)}%)`,
  );
  console.log(
    `  Points > 1.0 ft:  ${countAbove1} (${((100 * countAbove1) / pointCount).toFixed(2)}%)`,
  );

  if (maxDiff > 0) {
    const wp = refData.points[worstIdx];
    console.log(
      `  Worst point: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}) — GPU: ${gpuResults[worstIdx * 4].toFixed(6)}, Rust: ${wp.height.toFixed(6)}`,
    );
  }

  // Cross-implementation: independent spline sampling means some boundary
  // points will disagree. Tolerance catches gross algorithmic bugs.
  const crossImplTolerance = 10.0;
  assert(
    maxDiff < crossImplTolerance,
    `GPU vs Rust max diff ${maxDiff.toFixed(6)} exceeds tolerance ${crossImplTolerance}`,
  );
  console.log("  PASS");

  // =========================================================================
  // TEST B: GPU grid vs GPU fallback (zero IDW grid offsets)
  // =========================================================================
  // Same GPU, same f32 math, same packed buffer — the ONLY difference is
  // whether the IDW grid candidate set or the brute-force edge loop is used.
  // These should produce identical results if the grid includes all edges
  // that could be nearest for any point in each cell.
  console.log(
    "\n=== TEST B: GPU Grid vs GPU Fallback (same implementation) ===",
  );

  // Clone the packed buffer and zero all idwGridDataOffset fields
  const packedNoGrid = new Uint32Array(packed);
  const contoursOffset = packedNoGrid[1];
  for (let ci = 0; ci < contourCount; ci++) {
    const fieldOffset = contoursOffset + ci * FLOATS_PER_CONTOUR + 13;
    packedNoGrid[fieldOffset] = 0; // zero = no IDW grid → fallback path
  }

  const gpuFallbackResults = await runTerrainGPUTest(
    device,
    packedNoGrid,
    contourCount,
    defaultDepth,
    testPoints,
    pointCount,
  );

  let maxGridDiff = 0;
  let sumGridDiff = 0;
  let gridNonzero = 0;
  let gridAbove001 = 0;
  let gridAbove01 = 0;
  let gridAbove1 = 0;
  let gridWorstIdx = 0;
  let gridWorstGridVal = 0;
  let gridWorstFallbackVal = 0;

  for (let i = 0; i < pointCount; i++) {
    const gridHeight = gpuResults[i * 4];
    const fallbackHeight = gpuFallbackResults[i * 4];
    const diff = Math.abs(gridHeight - fallbackHeight);
    sumGridDiff += diff;
    if (diff > 0) gridNonzero++;
    if (diff > maxGridDiff) {
      maxGridDiff = diff;
      gridWorstIdx = i;
      gridWorstGridVal = gridHeight;
      gridWorstFallbackVal = fallbackHeight;
    }
    if (diff > 0.01) gridAbove001++;
    if (diff > 0.1) gridAbove01++;
    if (diff > 1.0) gridAbove1++;
  }

  const meanGridDiff = sumGridDiff / pointCount;
  console.log(`  Points tested:    ${pointCount}`);
  console.log(`  Max height diff:  ${maxGridDiff.toFixed(6)} ft`);
  console.log(`  Cumulative diff:  ${sumGridDiff.toFixed(6)} ft`);
  console.log(`  Mean diff:        ${meanGridDiff.toExponential(4)} ft`);
  console.log(
    `  Non-zero diffs:   ${gridNonzero} (${((100 * gridNonzero) / pointCount).toFixed(2)}%)`,
  );
  console.log(
    `  Points > 0.01 ft: ${gridAbove001} (${((100 * gridAbove001) / pointCount).toFixed(2)}%)`,
  );
  console.log(
    `  Points > 0.1 ft:  ${gridAbove01} (${((100 * gridAbove01) / pointCount).toFixed(2)}%)`,
  );
  console.log(
    `  Points > 1.0 ft:  ${gridAbove1} (${((100 * gridAbove1) / pointCount).toFixed(2)}%)`,
  );

  if (maxGridDiff > 0) {
    const wp = refData.points[gridWorstIdx];
    console.log(
      `  Worst point: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}) — grid: ${gridWorstGridVal.toFixed(6)}, fallback: ${gridWorstFallbackVal.toFixed(6)}`,
    );
  }

  // Grid and fallback use identical f32 data on the same GPU — any difference
  // means the grid's candidate edge set is missing edges.
  const gridTolerance = 1e-4;
  assert(
    maxGridDiff < gridTolerance,
    `Grid vs fallback max diff ${maxGridDiff.toFixed(6)} — grid candidate set is missing edges`,
  );
  console.log("  PASS");

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n=== All tests passed ===");

  device.destroy();
}

main().catch((err) => {
  console.error("\nTEST FAILED:", err.message ?? err);
  process.exit(1);
});
