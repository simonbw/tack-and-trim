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
 * - data: Type-specific parameters (3 floats)
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
  Ripple = 2,
  Current = 3,
  Obstacle = 4,
}

/**
 * Type-specific data for each modifier type.
 * Each variant has exactly 3 floats to maintain consistent buffer layout.
 */
export type WaterModifierTypeData =
  | WakeModifierData
  | RippleModifierData
  | CurrentModifierData
  | ObstacleModifierData;

/**
 * Wake modifier - circular falloff from moving point.
 * Used by WakeParticle for boat wake trails.
 */
export type WakeModifierData = {
  type: WaterModifierType.Wake;
  intensity: number; // Height amplitude (0-1 range typical)
  velocityX: number; // Water velocity X component
  velocityY: number; // Water velocity Y component
};

/**
 * Ripple modifier - expanding ring with wave pattern.
 * Used by AnchorSplashRipple for anchor splash effects.
 */
export type RippleModifierData = {
  type: WaterModifierType.Ripple;
  radius: number; // Current ring radius in world units
  intensity: number; // Height amplitude
  phase: number; // Wave phase (0-2π)
};

/**
 * Current modifier - directional flow field (future use).
 */
export type CurrentModifierData = {
  type: WaterModifierType.Current;
  velocityX: number;
  velocityY: number;
  fadeDistance: number; // Distance over which current fades
};

/**
 * Obstacle modifier - dampening zone (future use).
 */
export type ObstacleModifierData = {
  type: WaterModifierType.Obstacle;
  dampingFactor: number; // How much to dampen waves (0-1)
  padding1: number; // Reserved for future use
  padding2: number; // Reserved for future use
};
