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
}

/**
 * Type-specific data for each modifier type.
 * Wake uses 7 data floats (point source); other types use 3 floats.
 * All are packed into a fixed-stride buffer (see FLOATS_PER_MODIFIER).
 */
export type WaterModifierTypeData = WakeModifierData;

/**
 * Wake modifier — expanding ring pulse.
 * All physics (amplitude, spreading, damping) computed on CPU.
 * GPU just draws a Gaussian ring at the given radius.
 *
 * GPU buffer slots [5..10] — see FLOATS_PER_MODIFIER in WaterResources.ts.
 */
export type WakeModifierData = {
  type: WaterModifierType.Wake;
  posX: number; // [5] Source position X (ft)
  posY: number; // [6] Source position Y (ft)
  ringRadius: number; // [7] Distance from center to ring peak (ft)
  ringWidth: number; // [8] Gaussian width of ring pulse (ft)
  amplitude: number; // [9] Pre-computed height at ring (ft)
  turbulence: number; // [10] Pre-computed turbulence at ring (0-1)
};
