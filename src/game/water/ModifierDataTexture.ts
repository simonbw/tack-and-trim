import { DataTexture } from "../../core/graphics/texture/DataTexture";
import { profiler } from "../../core/util/Profiler";
import { V, V2d } from "../../core/Vector";
import { Viewport } from "./WaterComputePipeline";
import { WaterInfo } from "./WaterInfo";

// Modifier texture is smaller than wave texture since modifiers are sparse
const MODIFIER_TEXTURE_SIZE = 128;

// Height encoding: same as wave texture (height/5.0 + 0.5)
const HEIGHT_SCALE = 5.0;
const HEIGHT_OFFSET = 0.5;

/**
 * CPU-updated texture containing water modifier contributions (wakes, splashes).
 *
 * Updated each frame by iterating WaterModifier entities and baking their
 * height contributions into a 128x128 texture. Sampled by WaterShader
 * and combined with wave data for final rendering.
 *
 * Texel format (RGBA8):
 * - R: height contribution (0.5 = neutral, encoded as height/5.0 + 0.5)
 * - G: reserved (velocity X)
 * - B: reserved (velocity Y)
 * - A: reserved
 */
export class ModifierDataTexture extends DataTexture {
  // Reusable query point to avoid allocations
  private queryPoint: V2d = V(0, 0);

  constructor() {
    super(MODIFIER_TEXTURE_SIZE, MODIFIER_TEXTURE_SIZE);
    // Initialize to neutral values
    this.clearToNeutral();
  }

  /** Clear pixel buffer to neutral values (0.5 height = no contribution) */
  private clearToNeutral(): void {
    const neutralHeight = Math.round(HEIGHT_OFFSET * 255);
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = neutralHeight; // R: height
      this.pixels[i + 1] = 128; // G: reserved
      this.pixels[i + 2] = 128; // B: reserved
      this.pixels[i + 3] = 255; // A: reserved
    }
  }

  /**
   * Update the modifier texture with current water modifier contributions.
   * Iterates through modifiers and writes to affected texels (efficient for sparse modifiers).
   */
  update(viewport: Viewport, waterInfo: WaterInfo): void {
    if (!this.gl || !this.texture) return;

    profiler.start("modifier-texture");

    // Clear to neutral
    this.clearToNeutral();

    const { left, top, width, height } = viewport;
    const texelWidth = width / MODIFIER_TEXTURE_SIZE;
    const texelHeight = height / MODIFIER_TEXTURE_SIZE;

    // Iterate through all modifiers and write to affected texels
    let modifierCount = 0;
    for (const modifier of waterInfo.getAllModifiers()) {
      modifierCount++;
      // Get modifier's world-space AABB
      const aabb = modifier.getWaterModifierAABB();

      // Convert AABB to texel coordinates (clamped to texture bounds)
      const startTx = Math.max(0, Math.floor((aabb.minX - left) / texelWidth));
      const endTx = Math.min(
        MODIFIER_TEXTURE_SIZE - 1,
        Math.ceil((aabb.maxX - left) / texelWidth),
      );
      const startTy = Math.max(0, Math.floor((aabb.minY - top) / texelHeight));
      const endTy = Math.min(
        MODIFIER_TEXTURE_SIZE - 1,
        Math.ceil((aabb.maxY - top) / texelHeight),
      );

      // Skip if modifier is outside viewport
      if (startTx > endTx || startTy > endTy) continue;

      // For each texel in the modifier's AABB
      for (let ty = startTy; ty <= endTy; ty++) {
        for (let tx = startTx; tx <= endTx; tx++) {
          // Convert texel to world position (center of texel)
          this.queryPoint.x = left + (tx + 0.5) * texelWidth;
          this.queryPoint.y = top + (ty + 0.5) * texelHeight;

          // Get contribution at this point
          const contrib = modifier.getWaterContribution(this.queryPoint);

          if (contrib.height !== 0) {
            const pixelIndex = (ty * MODIFIER_TEXTURE_SIZE + tx) * 4;

            // Read current value, add contribution, clamp
            const currentNormalized = this.pixels[pixelIndex] / 255;
            const additionalNormalized = contrib.height / HEIGHT_SCALE;
            const newNormalized = currentNormalized + additionalNormalized;

            this.pixels[pixelIndex] = Math.round(
              Math.max(0, Math.min(255, newNormalized * 255)),
            );
          }
        }
      }
    }
    if (modifierCount > 0) {
      console.log("[ModifierDataTexture] Found", modifierCount, "modifiers");
    }

    // Upload to GPU
    this.upload();

    profiler.end("modifier-texture");
  }

  getTextureSize(): number {
    return MODIFIER_TEXTURE_SIZE;
  }
}
