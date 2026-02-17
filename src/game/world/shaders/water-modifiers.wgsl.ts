/**
 * Water modifier shader modules.
 * Compute contributions from wakes, ripples, currents, and obstacles.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Wake modifier module.
 * Tapered capsule SDF along a segment between two linked wake particles.
 * Computes point-to-segment distance for elongated wake trail shapes.
 *
 * Buffer layout at `base`:
 *   [5]  intensity     height-scaled wave amplitude (ft)
 *   [6]  posAX         segment start X (ft)
 *   [7]  posAY         segment start Y (ft)
 *   [8]  posBX         segment end X (ft)
 *   [9]  posBY         segment end Y (ft)
 *   [10] radiusA       influence radius at start (ft)
 *   [11] radiusB       influence radius at end (ft)
 *   [12] rawIntensity  unscaled intensity (0-1) for foam/turbulence
 */
export const fn_computeWakeContribution: ShaderModule = {
  code: /*wgsl*/ `
    // Compute wake contribution using capsule SDF (point-to-segment distance).
    // Returns vec4<f32>(height, 0, 0, turbulence)
    fn computeWakeContribution(
      worldX: f32,
      worldY: f32,
      base: u32,
      modifiers: ptr<storage, array<f32>, read>
    ) -> vec4<f32> {
      // Read wake-specific data (slots 5-12, see WakeModifierData)
      let intensity = modifiers[base + 5u];    // height-scaled amplitude (ft)
      let posAX = modifiers[base + 6u];        // segment start X (ft)
      let posAY = modifiers[base + 7u];        // segment start Y (ft)
      let posBX = modifiers[base + 8u];        // segment end X (ft)
      let posBY = modifiers[base + 9u];        // segment end Y (ft)
      let radiusA = modifiers[base + 10u];     // influence radius at start (ft)
      let radiusB = modifiers[base + 11u];     // influence radius at end (ft)
      let rawIntensity = modifiers[base + 12u]; // unscaled intensity for foam

      // Point-to-segment distance (capsule SDF)
      let abX = posBX - posAX;
      let abY = posBY - posAY;
      let abLenSq = abX * abX + abY * abY;

      // Project query point onto segment, clamp t to [0,1]
      var t: f32 = 0.0;
      if (abLenSq > 0.001) {
        t = clamp(((worldX - posAX) * abX + (worldY - posAY) * abY) / abLenSq, 0.0, 1.0);
      }

      // Closest point on segment
      let closestX = posAX + t * abX;
      let closestY = posAY + t * abY;
      let dx = worldX - closestX;
      let dy = worldY - closestY;
      let dist = sqrt(dx * dx + dy * dy);

      // Tapered radius: interpolate between radiusA and radiusB
      let radius = mix(radiusA, radiusB, t);

      // Smooth falloff from segment
      let falloff = smoothstep(radius, radius * 0.3, dist);

      // Ripple pattern: multiple rings spreading outward from segment
      let ripple = cos(dist * 0.8) * 0.7 + cos(dist * 1.6) * 0.3;

      // Turbulence for foam
      let wakeTurbulence = rawIntensity * falloff * falloff;

      // Return (height, velocityX, velocityY, turbulence)
      return vec4<f32>(
        intensity * falloff * ripple,
        0.0,
        0.0,
        wakeTurbulence
      );
    }
  `,
};

/**
 * Ripple modifier module.
 * Expanding ring with cosine wave profile.
 */
export const fn_computeRippleContribution: ShaderModule = {
  code: /*wgsl*/ `
    // Compute ripple contribution at a world position
    // worldX, worldY: query position (feet)
    // base: start index in modifiers buffer
    // modifiers: modifier data storage buffer
    // Returns vec4<f32>(height, velocityX, velocityY, turbulence)
    fn computeRippleContribution(
      worldX: f32,
      worldY: f32,
      base: u32,
      modifiers: ptr<storage, array<f32>, read>
    ) -> vec4<f32> {
      let radius = modifiers[base + 5u];
      let intensity = modifiers[base + 6u];
      let phase = modifiers[base + 7u];

      let minX = modifiers[base + 1u];
      let minY = modifiers[base + 2u];
      let maxX = modifiers[base + 3u];
      let maxY = modifiers[base + 4u];
      let centerX = (minX + maxX) * 0.5;
      let centerY = (minY + maxY) * 0.5;
      let dx = worldX - centerX;
      let dy = worldY - centerY;
      let dist = sqrt(dx * dx + dy * dy);

      // Ring-based falloff (2ft wide ring)
      let ringWidth = 2.0;
      let distFromRing = abs(dist - radius);
      let falloff = max(0.0, 1.0 - distFromRing / ringWidth);

      // Cosine wave profile
      let height = intensity * falloff * cos(phase);

      return vec4<f32>(height, 0.0, 0.0, 0.0);
    }
  `,
};

/**
 * Current modifier module.
 * Directional flow field (future use).
 */
export const fn_computeCurrentContribution: ShaderModule = {
  code: /*wgsl*/ `
    // Compute current contribution at a world position
    // worldX, worldY: query position (feet)
    // base: start index in modifiers buffer
    // modifiers: modifier data storage buffer
    // Returns vec4<f32>(height, velocityX, velocityY, turbulence)
    fn computeCurrentContribution(
      worldX: f32,
      worldY: f32,
      base: u32,
      modifiers: ptr<storage, array<f32>, read>
    ) -> vec4<f32> {
      let velocityX = modifiers[base + 5u];
      let velocityY = modifiers[base + 6u];
      let fadeDistance = modifiers[base + 7u];

      // Simple constant velocity for now
      return vec4<f32>(0.0, velocityX, velocityY, 0.0);
    }
  `,
};

/**
 * Obstacle modifier module.
 * Dampening zone (future use).
 */
export const fn_computeObstacleContribution: ShaderModule = {
  code: /*wgsl*/ `
    // Compute obstacle contribution at a world position
    // worldX, worldY: query position (feet)
    // base: start index in modifiers buffer
    // modifiers: modifier data storage buffer
    // Returns vec4<f32>(height, velocityX, velocityY, turbulence)
    fn computeObstacleContribution(
      worldX: f32,
      worldY: f32,
      base: u32,
      modifiers: ptr<storage, array<f32>, read>
    ) -> vec4<f32> {
      let dampingFactor = modifiers[base + 5u];

      // Not implemented yet - return zero contribution
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
  `,
};

/**
 * Modifier type constants.
 * Type discriminators for different modifier kinds.
 */
export const const_MODIFIER_TYPES: ShaderModule = {
  code: /*wgsl*/ `
    // Modifier type discriminators
    const MODIFIER_TYPE_WAKE: u32 = 1u;
    const MODIFIER_TYPE_RIPPLE: u32 = 2u;
    const MODIFIER_TYPE_CURRENT: u32 = 3u;
    const MODIFIER_TYPE_OBSTACLE: u32 = 4u;
  `,
};

/**
 * Get contribution from a single modifier with type discrimination.
 */
export const fn_getModifierContribution: ShaderModule = {
  code: /*wgsl*/ `
    // Get contribution from a single modifier with type discrimination
    // worldX, worldY: query position (feet)
    // modifierIndex: modifier index
    // modifiers: modifier data storage buffer
    // floatsPerModifier: number of floats per modifier
    // Returns vec4<f32>(height, velocityX, velocityY, turbulence)
    fn getModifierContribution(
      worldX: f32,
      worldY: f32,
      modifierIndex: u32,
      modifiers: ptr<storage, array<f32>, read>,
      floatsPerModifier: u32
    ) -> vec4<f32> {
      let base = modifierIndex * floatsPerModifier;

      // Read header
      let modType = u32(modifiers[base + 0u]);
      let minX = modifiers[base + 1u];
      let minY = modifiers[base + 2u];
      let maxX = modifiers[base + 3u];
      let maxY = modifiers[base + 4u];

      // Bounds culling (early exit)
      if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
      }

      // Type discrimination
      switch (modType) {
        case MODIFIER_TYPE_WAKE: {
          return computeWakeContribution(worldX, worldY, base, modifiers);
        }
        case MODIFIER_TYPE_RIPPLE: {
          return computeRippleContribution(worldX, worldY, base, modifiers);
        }
        case MODIFIER_TYPE_CURRENT: {
          return computeCurrentContribution(worldX, worldY, base, modifiers);
        }
        case MODIFIER_TYPE_OBSTACLE: {
          return computeObstacleContribution(worldX, worldY, base, modifiers);
        }
        default: {
          return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
      }
    }
  `,
  dependencies: [
    const_MODIFIER_TYPES,
    fn_computeWakeContribution,
    fn_computeRippleContribution,
    fn_computeCurrentContribution,
    fn_computeObstacleContribution,
  ],
};

/**
 * Calculate combined modifier contributions.
 */
export const fn_calculateModifiers: ShaderModule = {
  code: /*wgsl*/ `
    // Calculate combined modifier contributions
    // worldX, worldY: query position (feet)
    // modifierCount: number of active modifiers
    // maxModifiers: maximum modifiers to check
    // modifiers: modifier data storage buffer
    // floatsPerModifier: number of floats per modifier
    // Returns vec4<f32>(totalHeight, totalVelX, totalVelY, maxTurbulence)
    fn calculateModifiers(
      worldX: f32,
      worldY: f32,
      modifierCount: u32,
      maxModifiers: u32,
      modifiers: ptr<storage, array<f32>, read>,
      floatsPerModifier: u32
    ) -> vec4<f32> {
      var totalHeight: f32 = 0.0;
      var totalVelX: f32 = 0.0;
      var totalVelY: f32 = 0.0;
      var maxTurb: f32 = 0.0;

      let count = min(modifierCount, maxModifiers);
      for (var i: u32 = 0u; i < count; i++) {
        let contrib = getModifierContribution(worldX, worldY, i, modifiers, floatsPerModifier);
        totalHeight += contrib.x;
        totalVelX += contrib.y;
        totalVelY += contrib.z;
        maxTurb = max(maxTurb, contrib.w);
      }

      return vec4<f32>(totalHeight, totalVelX, totalVelY, maxTurb);
    }
  `,
  dependencies: [fn_getModifierContribution],
};
