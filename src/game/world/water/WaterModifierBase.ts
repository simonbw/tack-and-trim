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
  Ripple = 2,
  Current = 3,
  Obstacle = 4,
}

/**
 * Type-specific data for each modifier type.
 * Wake uses 8 data floats (capsule segment); other types use 3 floats.
 * All are packed into a fixed-stride buffer (see FLOATS_PER_MODIFIER).
 */
export type WaterModifierTypeData =
  | WakeModifierData
  | RippleModifierData
  | CurrentModifierData
  | ObstacleModifierData;

/**
 * Wake modifier — tapered capsule along a segment between two linked WakeParticles.
 * The shader computes point-to-segment distance for an elongated falloff shape.
 * Tail particles (no next neighbor) set posB = posA, degenerating to a circle.
 *
 * GPU buffer slots [5..12] — see FLOATS_PER_MODIFIER in WaterResources.ts.
 */
export type WakeModifierData = {
  type: WaterModifierType.Wake;
  intensity: number; // [5] Height-scaled wave amplitude (ft)
  posAX: number; // [6] Segment start X — this particle's position (ft)
  posAY: number; // [7] Segment start Y (ft)
  posBX: number; // [8] Segment end X — next particle's position (ft)
  posBY: number; // [9] Segment end Y (ft)
  radiusA: number; // [10] Influence radius at start (ft), expands with age
  radiusB: number; // [11] Influence radius at end (ft)
  rawIntensity: number; // [12] Unscaled intensity (0-1) for foam/turbulence
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
