/**
 * Base class for compute shaders.
 *
 * Handles GPU pipeline boilerplate so subclasses just declare:
 * - `code`: WGSL shader code (or use modules + mainCode)
 * - `bindings`: typed binding definitions
 * - `workgroupSize`: workgroup dimensions
 *
 * The base class handles:
 * - Shader module creation
 * - Bind group layout creation (from binding definitions)
 * - Pipeline layout and compute pipeline creation
 * - Type-safe bind group creation
 * - Workgroup dispatch math
 *
 * Module Support:
 * - Set `modules` to compose reusable WGSL code
 * - Set `mainCode` for compute entry point when using modules
 * - Or use `code` directly for backwards compatibility
 */

import { getWebGPU } from "./WebGPUDevice";
import { Shader } from "./Shader";
import {
  type BindingsDefinition,
  createBindGroupLayoutEntries,
} from "./ShaderBindings";

/**
 * Abstract base class for compute shaders.
 *
 * @template T - The bindings definition type for type-safe bind group creation
 */
export abstract class ComputeShader<
  T extends BindingsDefinition,
> extends Shader<T> {
  /** WGSL shader code. Optional when using modules. */
  code?: string;

  /** Main compute code when using modules. */
  protected mainCode?: string;

  /** Workgroup size [x, y] or [x, y, z]. Subclasses must provide this. */
  abstract readonly workgroupSize:
    | readonly [number, number]
    | readonly [number, number, number];

  /** Label for GPU debugging. Subclasses can override. */
  get label(): string {
    return this.constructor.name;
  }

  private pipeline: GPUComputePipeline | null = null;

  /**
   * Get shader code from either direct code or modules.
   */
  protected getShaderCode(): string {
    if (this.code) {
      return this.code;
    }
    if (this.modules && this.mainCode) {
      return this.buildCode(this.mainCode);
    }
    throw new Error(
      `${this.label}: Must provide either 'code' or 'modules' + 'mainCode'`,
    );
  }

  /**
   * Initialize the compute pipeline.
   * Must be called before dispatch.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Build complete shader with math constants once at the top
    const completeShaderCode =
      this.getMathConstants() + "\n\n" + this.getShaderCode();

    const shaderModule = device.createShaderModule({
      code: completeShaderCode,
      label: `${this.label} Shader Module`,
    });

    // Create bind group layout from binding definitions
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: createBindGroupLayoutEntries(
        this.bindings,
        GPUShaderStage.COMPUTE,
      ),
      label: `${this.label} Bind Group Layout`,
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: `${this.label} Pipeline Layout`,
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
      label: `${this.label} Compute Pipeline`,
    });
  }

  /**
   * Get the compute pipeline.
   */
  getPipeline(): GPUComputePipeline {
    if (!this.pipeline) {
      throw new Error(`${this.label} not initialized`);
    }
    return this.pipeline;
  }

  /**
   * Dispatch the compute shader.
   *
   * @param computePass - The compute pass to dispatch on
   * @param bindGroup - Bind group with resources
   * @param textureWidth - Width of the output texture
   * @param textureHeight - Height of the output texture (defaults to width for square textures)
   */
  dispatch(
    computePass: GPUComputePassEncoder,
    bindGroup: GPUBindGroup,
    textureWidth: number,
    textureHeight?: number,
  ): void {
    if (!this.pipeline) {
      console.warn(`${this.label} not initialized`);
      return;
    }

    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, bindGroup);

    const height = textureHeight ?? textureWidth;
    const workgroupsX = Math.ceil(textureWidth / this.workgroupSize[0]);
    const workgroupsY = Math.ceil(height / this.workgroupSize[1]);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
