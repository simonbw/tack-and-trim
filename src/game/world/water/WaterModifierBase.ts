import { BaseEntity } from "../../../core/entity/BaseEntity";
import { AABB } from "../../../core/physics/collision/AABB";

/**
 * Base class for all water modifiers in the GPU-based water system.
 *
 * Water modifiers affect water height and velocity in the analytical water shader.
 * All modifiers export GPU data each frame via getGPUModifierData(), which is
 * written to a unified modifier buffer and processed by the compute shader.
 */
export abstract class WaterModifier extends BaseEntity {
  tags = ["waterModifier"];

  /**
   * Returns the axis-aligned bounding box for this modifier.
   * Used for:
   * - GPU bounds culling (early exit in shader)
   * - Tag discovery (finding modifiers in EntityList)
   */
  abstract getWaterModifierAABB(): AABB;

  /**
   * Returns GPU buffer data for this modifier, or null if not renderable this frame.
   * Called once per frame during modifier collection.
   *
   * Returning null:
   * - Excludes this modifier from the GPU buffer
   * - Useful for faded out effects, dead particles, etc.
   */
  abstract getGPUModifierData(): GPUWaterModifierData | null;
}

/**
 * Discriminated union for GPU buffer export.
 * Each modifier exports:
 * - type: Enum discriminator for shader switching
 * - bounds: AABB for GPU culling
 * - data: Type-specific parameters (packed into GPU buffer slots [5..13])
 *
 * See FLOATS_PER_MODIFIER in WaterResources.ts for the full GPU buffer layout.
 */
export type GPUWaterModifierData = {
  type: WaterModifierType;
  bounds: AABB;
  data: WaterModifierTypeData;
};

/**
 * Modifier type discriminator.
 * Maps to u32 constants in WGSL shader.
 */
export enum WaterModifierType {
  Wake = 1,
  Foam = 5,
}

/**
 * Type-specific data for each modifier type.
 * All are packed into a fixed-stride buffer (see FLOATS_PER_MODIFIER).
 */
export type WaterModifierTypeData = WakeModifierData | FoamModifierData;

/**
 * Wake modifier — coherent expanding ring pulse (wave-making).
 * All physics (amplitude, spreading, damping) computed on CPU.
 * GPU just draws a Gaussian ring at the given radius with given amplitude.
 *
 * GPU buffer slots [5..11] — see FLOATS_PER_MODIFIER in WaterResources.ts.
 */
export type WakeModifierData = {
  type: WaterModifierType.Wake;
  posX: number; // [5] Source position X (ft)
  posY: number; // [6] Source position Y (ft)
  ringRadius: number; // [7] Distance from center to ring peak (ft)
  ringWidth: number; // [8] Gaussian width of ring pulse (ft)
  amplitude: number; // [9] Pre-computed height at ring (ft)
  omega: number; // [10] Angular frequency of wake wave (rad/s)
};

/**
 * Foam modifier — slow-fading turbulent splat (flow-separation wake).
 * Static Gaussian blob that contributes only to the turbulence/foam channel;
 * no surface height deformation, no orbital velocity.
 *
 * GPU buffer slots [5..8] — see FLOATS_PER_MODIFIER in WaterResources.ts.
 */
export type FoamModifierData = {
  type: WaterModifierType.Foam;
  posX: number; // [5] Center position X (ft)
  posY: number; // [6] Center position Y (ft)
  radius: number; // [7] Gaussian width of the blob (ft)
  intensity: number; // [8] Pre-computed foam intensity (0-1)
};
