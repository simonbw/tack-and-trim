/**
 * GPU compute shader for swell propagation.
 *
 * Implements iterative relaxation (Jacobi-style) on the GPU.
 * Uses 3D dispatch to process all 32 direction/wavelength combinations
 * simultaneously (16 directions × 2 wavelength types).
 *
 * Z dimension encoding:
 * - sliceIndex 0-15: long swell (directions 0-15)
 * - sliceIndex 16-31: short chop (directions 0-15)
 *
 * Uses ping-pong buffers - caller swaps energyIn/energyOut each iteration.
 * The algorithm propagates energy from boundary cells through water cells,
 * simulating how waves diffract around terrain obstacles.
 *
 * Supports f16 (half-precision) energy storage when available for improved
 * memory bandwidth. Energy values are clamped to [0,1] so f16 precision is
 * more than sufficient.
 */

import { ComputeShader } from "../../../../../core/graphics/webgpu/ComputeShader";
import { getWebGPU } from "../../../../../core/graphics/webgpu/WebGPUDevice";

const bindings = {
  params: { type: "uniform" },
  depthGrid: { type: "storage" },
  energyIn: { type: "storage" },
  energyOut: { type: "storageRW" },
  arrivalDirOut: { type: "storageRW" },
} as const;

/**
 * Parameters passed to the shader via uniform buffer.
 * Must match the WGSL Params struct layout (16-byte aligned).
 * Contains configs for both long swell and short chop.
 */
export interface SwellPropagationParams {
  cellsX: number;
  cellsY: number;
  directionCount: number; // 16 directions
  isInitPass: number; // 1 = initialize boundaries, 0 = iterate
  // Long swell config
  longDirectFlow: number;
  longLateralSpread: number;
  longDecay: number;
  _padding1: number;
  // Short chop config
  shortDirectFlow: number;
  shortLateralSpread: number;
  shortDecay: number;
  _padding2: number;
}

/**
 * Size of params buffer in bytes:
 * - 12 u32/f32 values = 48 bytes (grid config + propagation params)
 * - 16 f32 for dirCosines = 64 bytes
 * - 16 f32 for dirSines = 64 bytes
 * Total = 176 bytes
 */
export const PARAMS_BUFFER_SIZE = 176;

/**
 * Swell propagation compute shader.
 *
 * Processes all 32 direction/wavelength slices in parallel using 3D dispatch.
 * The caller is responsible for:
 * - Managing ping-pong buffers (swap energyIn/energyOut between iterations)
 * - Running the init pass first (isInitPass = 1) to set boundary conditions
 * - Running iteration passes until maxIterations
 */
export class SwellPropagationShader extends ComputeShader<typeof bindings> {
  readonly bindings = bindings;
  readonly workgroupSize = [8, 8, 1] as const;

  /** Whether f16 is being used for energy storage */
  readonly useF16: boolean;

  constructor() {
    super();
    this.useF16 = getWebGPU().features.shaderF16;
  }

  get code(): string {
    const energyType = this.useF16 ? "f16" : "f32";
    const enableF16 = this.useF16 ? "enable f16;\n\n" : "";
    // For f16, we need explicit conversions since WGSL is strictly typed
    const toEnergy = this.useF16
      ? (v: string) => `${energyType}(${v})`
      : (v: string) => v;
    const fromEnergy = this.useF16
      ? (v: string) => `f32(${v})`
      : (v: string) => v;

    return /*wgsl*/ `${enableF16}// ============================================================================
// Constants
// ============================================================================
const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;

// Neighbor offsets for 8-connected grid (Moore neighborhood)
const NEIGHBOR_COUNT: u32 = 8u;
const NEIGHBOR_DX: array<i32, 8> = array<i32, 8>(-1, 0, 1, -1, 1, -1, 0, 1);
const NEIGHBOR_DY: array<i32, 8> = array<i32, 8>(-1, -1, -1, 0, 0, 1, 1, 1);

// Precomputed normalized neighbor directions (avoids sqrt in hot loop)
// For cardinal directions (0,1,3,4,6): magnitude = 1.0
// For diagonal directions (0,2,5,7): magnitude = sqrt(2) ≈ 1.414, so normalized = 0.7071
const INV_SQRT2: f32 = 0.70710678118;
const NEIGHBOR_NORM_DX: array<f32, 8> = array<f32, 8>(-INV_SQRT2, 0.0, INV_SQRT2, -1.0, 1.0, -INV_SQRT2, 0.0, INV_SQRT2);
const NEIGHBOR_NORM_DY: array<f32, 8> = array<f32, 8>(-INV_SQRT2, -1.0, -INV_SQRT2, 0.0, 0.0, INV_SQRT2, 1.0, INV_SQRT2);

// ============================================================================
// Uniforms and Bindings
// ============================================================================
struct Params {
  cellsX: u32,
  cellsY: u32,
  directionCount: u32,
  isInitPass: u32,
  // Long swell config
  longDirectFlow: f32,
  longLateralSpread: f32,
  longDecay: f32,
  _padding1: u32,
  // Short chop config
  shortDirectFlow: f32,
  shortLateralSpread: f32,
  shortDecay: f32,
  _padding2: u32,
  // Precomputed direction vectors (avoids trig per thread)
  dirCosines: array<f32, 16>,
  dirSines: array<f32, 16>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> depthGrid: array<f32>;
@group(0) @binding(2) var<storage, read> energyIn: array<${energyType}>;
@group(0) @binding(3) var<storage, read_write> energyOut: array<${energyType}>;
@group(0) @binding(4) var<storage, read_write> arrivalDirOut: array<f32>;

// ============================================================================
// Helper Functions
// ============================================================================

fn getCellIndex(x: u32, y: u32) -> u32 {
  return y * params.cellsX + x;
}

fn get3DIndex(x: u32, y: u32, sliceIndex: u32) -> u32 {
  // 3D buffer layout: [sliceIndex][y][x]
  let cellCount = params.cellsX * params.cellsY;
  return sliceIndex * cellCount + y * params.cellsX + x;
}

fn isWater(x: u32, y: u32) -> bool {
  let idx = getCellIndex(x, y);
  // Negative depth = underwater (water cell), positive/zero = land
  return depthGrid[idx] < 0.0;
}

fn isUpwindBoundary(x: u32, y: u32, sourceDirX: f32, sourceDirY: f32) -> bool {
  // If source comes from the right (+X), left edge is upwind
  if (sourceDirX > 0.1 && x == 0u) { return true; }
  // If source comes from the left (-X), right edge is upwind
  if (sourceDirX < -0.1 && x == params.cellsX - 1u) { return true; }
  // If source comes from above (+Y), bottom edge is upwind
  if (sourceDirY > 0.1 && y == 0u) { return true; }
  // If source comes from below (-Y), top edge is upwind
  if (sourceDirY < -0.1 && y == params.cellsY - 1u) { return true; }
  return false;
}

fn clamp01(value: f32) -> f32 {
  return max(0.0, min(1.0, value));
}

// ============================================================================
// Main Compute Shader
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let x = globalId.x;
  let y = globalId.y;
  let sliceIndex = globalId.z;  // 0-31: 0-15 = long swell, 16-31 = short chop

  // Bounds check
  let totalSlices = params.directionCount * 2u;
  if (x >= params.cellsX || y >= params.cellsY || sliceIndex >= totalSlices) {
    return;
  }

  // Decode slice index to get direction and wavelength type
  let isLongSwell = sliceIndex < params.directionCount;
  let dirIndex = select(sliceIndex - params.directionCount, sliceIndex, isLongSwell);

  // Select config based on wavelength type
  let directFlowFactor = select(params.shortDirectFlow, params.longDirectFlow, isLongSwell);
  let lateralSpreadFactor = select(params.shortLateralSpread, params.longLateralSpread, isLongSwell);
  let decayFactor = select(params.shortDecay, params.longDecay, isLongSwell);

  // Use precomputed direction vectors (avoids trig per thread)
  let sourceDirX = params.dirCosines[dirIndex];
  let sourceDirY = params.dirSines[dirIndex];

  // 3D index into buffers
  let idx = get3DIndex(x, y, sliceIndex);

  // Land cell - always 0 energy
  if (!isWater(x, y)) {
    energyOut[idx] = ${toEnergy("0.0")};
    arrivalDirOut[idx] = atan2(sourceDirY, sourceDirX);
    return;
  }

  // Boundary cell - always 1 energy, direction = source direction
  if (isUpwindBoundary(x, y, sourceDirX, sourceDirY)) {
    energyOut[idx] = ${toEnergy("1.0")};
    arrivalDirOut[idx] = atan2(sourceDirY, sourceDirX);
    return;
  }

  // Init pass: set all non-boundary water cells to 0
  if (params.isInitPass == 1u) {
    energyOut[idx] = ${toEnergy("0.0")};
    arrivalDirOut[idx] = atan2(sourceDirY, sourceDirX);
    return;
  }

  // Iteration pass: weighted average of neighbors
  var totalEnergy: f32 = 0.0;
  var totalWeight: f32 = 0.0;
  var weightedDirX: f32 = 0.0;
  var weightedDirY: f32 = 0.0;

  for (var i: u32 = 0u; i < NEIGHBOR_COUNT; i++) {
    let nx = i32(x) + NEIGHBOR_DX[i];
    let ny = i32(y) + NEIGHBOR_DY[i];

    // Bounds check
    if (nx < 0 || nx >= i32(params.cellsX) || ny < 0 || ny >= i32(params.cellsY)) {
      continue;
    }

    let neighborX = u32(nx);
    let neighborY = u32(ny);

    // Skip land cells
    if (!isWater(neighborX, neighborY)) {
      continue;
    }

    // Use precomputed normalized flow direction (from neighbor to current cell)
    // Note: NEIGHBOR_NORM_DX/DY store offsets (neighbor position relative to current),
    // so we negate to get the direction FROM neighbor TO current cell
    let normFlowDirX = -NEIGHBOR_NORM_DX[i];
    let normFlowDirY = -NEIGHBOR_NORM_DY[i];

    // How aligned is the flow with the source direction?
    // alignment = 1 when flowing directly with source, -1 when against
    let alignment = normFlowDirX * sourceDirX + normFlowDirY * sourceDirY;

    // Energy doesn't flow backwards
    if (alignment <= 0.0) {
      continue;
    }

    // Direct flow component (aligned with source direction)
    let directWeight = alignment * directFlowFactor;

    // Lateral spread component (perpendicular to source direction)
    let lateralWeight = (1.0 - alignment) * lateralSpreadFactor;

    // Combined weight with decay
    let weight = (directWeight + lateralWeight) * decayFactor;

    if (weight > 0.0) {
      let neighborIdx = get3DIndex(neighborX, neighborY, sliceIndex);
      let neighborEnergy = ${fromEnergy("energyIn[neighborIdx]")};
      let contribution = neighborEnergy * weight;

      totalWeight += weight;
      totalEnergy += contribution;

      // Accumulate weighted flow direction for arrival direction
      weightedDirX += normFlowDirX * contribution;
      weightedDirY += normFlowDirY * contribution;
    }
  }

  // Compute new energy
  var newEnergy: f32 = 0.0;
  if (totalWeight > 0.0) {
    newEnergy = clamp01(totalEnergy / totalWeight);
  }
  energyOut[idx] = ${toEnergy("newEnergy")};

  // Compute arrival direction from weighted flow directions
  let dirMag = sqrt(weightedDirX * weightedDirX + weightedDirY * weightedDirY);
  if (dirMag > 0.001) {
    arrivalDirOut[idx] = atan2(weightedDirY / dirMag, weightedDirX / dirMag);
  } else {
    arrivalDirOut[idx] = atan2(sourceDirY, sourceDirX);
  }
}
`;
  }
}
