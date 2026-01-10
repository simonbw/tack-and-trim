/**
 * WebGPU Water System
 *
 * Provides WebGPU-based water rendering:
 * - WaveComputeGPU: Compute shader for Gerstner waves
 * - WaterShaderGPU: Render shader for water surface
 * - WaterComputePipelineGPU: Orchestrates wave computation
 * - WaterRendererGPU: Entity for water rendering
 */

export { WaveComputeGPU } from "./WaveComputeGPU";
export { WaterShaderGPU } from "./WaterShaderGPU";
export { WaterComputePipelineGPU, type Viewport } from "./WaterComputePipelineGPU";
export { WaterRendererGPU } from "./WaterRendererGPU";
