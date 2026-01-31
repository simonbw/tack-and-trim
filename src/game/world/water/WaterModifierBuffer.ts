/**
 * WaterModifierBuffer: Manages GPU storage buffer for water modifiers.
 *
 * Collects WaterModifier entities and uploads them to a GPU buffer
 * in a packed format for shader access.
 *
 * GPU Layout (8 floats = 32 bytes per modifier):
 * [0] modifierType (1=wake, 2=current, 3=obstacle)
 * [1-2] boundsMin (x, y)
 * [3-4] boundsMax (x, y)
 * [5-7] type-specific params
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import type { WaterModifier } from "./WaterModifier";

/**
 * Maximum number of modifiers supported by the GPU buffer
 */
export const MAX_MODIFIERS = 16384;

/**
 * Number of floats per modifier in GPU buffer
 */
const MODIFIER_STRIDE = 8;

/**
 * Modifier type enum for GPU shader
 */
enum ModifierType {
  Wake = 1,
  Current = 2,
  Obstacle = 3,
}

/**
 * Manages GPU buffer for water modifiers
 */
export class WaterModifierBuffer {
  private buffer: GPUBuffer | null = null;
  private activeCount = 0;

  constructor() {
    this.initializeBuffer();
  }

  /**
   * Initialize the GPU buffer
   */
  private initializeBuffer(): void {
    const device = getWebGPU().device;

    const bufferSize =
      MAX_MODIFIERS * MODIFIER_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    this.buffer = device.createBuffer({
      label: "WaterModifierBuffer",
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Update buffer with current modifiers from the game.
   *
   * Collects all WaterModifier entities and uploads their data to GPU.
   * If more than MAX_MODIFIERS exist, only the first MAX_MODIFIERS are used.
   *
   * @param modifiers Array of water modifiers to upload
   */
  update(modifiers: WaterModifier[]): void {
    if (!this.buffer) {
      console.warn("[WaterModifierBuffer] Buffer not initialized");
      return;
    }

    // Limit to MAX_MODIFIERS
    const count = Math.min(modifiers.length, MAX_MODIFIERS);
    this.activeCount = count;

    if (count > MAX_MODIFIERS) {
      console.warn(
        `[WaterModifierBuffer] Modifier count (${modifiers.length}) exceeds MAX_MODIFIERS (${MAX_MODIFIERS}), truncating`,
      );
    }

    if (count === 0) {
      // No modifiers to upload
      return;
    }

    // Pack modifier data
    const data = new Float32Array(count * MODIFIER_STRIDE);

    for (let i = 0; i < count; i++) {
      const modifier = modifiers[i];
      const bounds = modifier.getBounds();
      const modifierData = modifier.getModifierData();

      const offset = i * MODIFIER_STRIDE;

      // Pack common data (type + bounds)
      let modifierType: ModifierType;
      switch (modifierData.type) {
        case "wake":
          modifierType = ModifierType.Wake;
          break;
        case "current":
          modifierType = ModifierType.Current;
          break;
        case "obstacle":
          modifierType = ModifierType.Obstacle;
          break;
      }

      data[offset + 0] = modifierType;
      data[offset + 1] = bounds.lowerBound.x;
      data[offset + 2] = bounds.lowerBound.y;
      data[offset + 3] = bounds.upperBound.x;
      data[offset + 4] = bounds.upperBound.y;

      // Pack type-specific params
      switch (modifierData.type) {
        case "wake":
          data[offset + 5] = modifierData.strength;
          data[offset + 6] = modifierData.direction;
          data[offset + 7] = 0; // padding
          break;
        case "current":
          data[offset + 5] = modifierData.velocity.x;
          data[offset + 6] = modifierData.velocity.y;
          data[offset + 7] = 0; // padding
          break;
        case "obstacle":
          data[offset + 5] = modifierData.dampingFactor;
          data[offset + 6] = 0; // padding
          data[offset + 7] = 0; // padding
          break;
      }
    }

    // Upload to GPU
    const device = getWebGPU().device;
    device.queue.writeBuffer(this.buffer, 0, data);
  }

  /**
   * Get the GPU buffer for binding
   */
  getBuffer(): GPUBuffer | null {
    return this.buffer;
  }

  /**
   * Get the number of active modifiers currently in the buffer
   */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.buffer?.destroy();
    this.buffer = null;
    this.activeCount = 0;
  }
}
