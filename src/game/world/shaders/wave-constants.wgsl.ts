/**
 * Wave system constants shared between CPU and GPU.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { MAX_WAVE_SOURCES } from "../../wave-physics/WavePhysicsManager";

/**
 * Maximum wave source count constant for WGSL shaders.
 */
export const const_MAX_WAVE_SOURCES: ShaderModule = {
  code: /*wgsl*/ `
const MAX_WAVE_SOURCES: u32 = ${MAX_WAVE_SOURCES}u;
`,
};
