/**
 * WebGPU Water Physics
 *
 * Provides WebGPU-based water physics computation using analytical wave physics.
 * - AnalyticalWaterDataTileCompute: Physics tile compute with shadow-based diffraction
 * - AnalyticalWaterStateShader: Compute shader for waves + modifiers
 * - WaterComputeBuffers: Shared buffer management
 *
 * For rendering, see water/rendering/
 */

export {
  WaterComputeBuffers,
  type WaterComputeParams,
} from "./WaterComputeBuffers";

export {
  AnalyticalWaterDataTileCompute,
  type AnalyticalWaterConfig,
} from "./AnalyticalWaterDataTileCompute";

export { AnalyticalWaterStateShader } from "./AnalyticalWaterStateShader";
