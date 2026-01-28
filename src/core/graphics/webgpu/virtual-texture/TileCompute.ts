import { ComputeShader } from "../ComputeShader";
import type { BindingsDefinition } from "../ShaderBindings";

/**
 * Abstract base class for tile computation shaders.
 *
 * Provides common tile computation infrastructure:
 * - 8×8 workgroup size (64 threads for 128×128 tile = 16×16 workgroups)
 * - Tile dispatch helper method
 *
 * Subclasses must implement:
 * - code: WGSL shader code
 * - bindings: Binding definitions for this shader
 *
 * @template B - The bindings definition type
 */
export abstract class TileCompute<
  B extends BindingsDefinition,
> extends ComputeShader<B> {
  /** Fixed workgroup size for tile computation */
  readonly workgroupSize = [8, 8] as const;

  /**
   * Dispatch compute shader to generate a single tile.
   *
   * @param commandEncoder - GPU command encoder
   * @param bindGroup - Bind group with tile-specific resources
   * @param tileSize - Size of tile in pixels (default 128)
   */
  computeTile(
    commandEncoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    tileSize: number = 128,
  ): void {
    const computePass = commandEncoder.beginComputePass({
      label: `${this.label} Compute Tile`,
    });

    this.dispatch(computePass, bindGroup, tileSize, tileSize);

    computePass.end();
  }
}
