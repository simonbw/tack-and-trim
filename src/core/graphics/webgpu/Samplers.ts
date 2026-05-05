/**
 * Shared sampler descriptors and helpers for the WebGPU rendering layer.
 *
 * Most surface-rendering passes want the same sampler: linear min/mag,
 * clamp-to-edge on both axes. Centralizing the descriptor avoids the
 * "five call sites copy-paste the same four lines" pattern and makes the
 * intent at each call site explicit.
 */

/**
 * Linear filtering with clamp-to-edge addressing — the default for screen-
 * space surface textures (water height, wind field, modifier, wetness, etc).
 *
 * Pass to `device.createSampler({ ...LINEAR_CLAMP_SAMPLER_DESCRIPTOR, label })`
 * to add a debug label, or use `createLinearClampSampler()` directly.
 */
export const LINEAR_CLAMP_SAMPLER_DESCRIPTOR: GPUSamplerDescriptor = {
  magFilter: "linear",
  minFilter: "linear",
  addressModeU: "clamp-to-edge",
  addressModeV: "clamp-to-edge",
};

/**
 * Create a linear-filter, clamp-to-edge sampler with the given debug label.
 */
export function createLinearClampSampler(
  device: GPUDevice,
  label: string,
): GPUSampler {
  return device.createSampler({ ...LINEAR_CLAMP_SAMPLER_DESCRIPTOR, label });
}
