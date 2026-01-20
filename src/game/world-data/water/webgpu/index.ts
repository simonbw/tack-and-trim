/**
 * WebGPU Water Physics
 *
 * Provides WebGPU-based water physics computation:
 * - WaterStateCompute: Unified compute shader for waves + modifiers
 * - WaterComputeBuffers: Shared buffer management
 * - WaterPhysicsTileCompute: Physics tile compute
 *
 * For rendering, see water/rendering/
 */

export {
  WaterComputeBuffers,
  type WakeSegmentData,
  type WaterComputeParams,
} from "./WaterComputeBuffers";
export {
  WaterDataTileCompute as WaterPhysicsTileCompute,
  type WaterPointData,
} from "./WaterDataTileCompute";
export { WATER_STATE_SHADER, WaterStateCompute } from "./WaterStateCompute";
