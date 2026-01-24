/**
 * Base class for compute shaders.
 *
 * Handles GPU pipeline boilerplate so subclasses just declare:
 * - `code`: WGSL shader code
 * - `bindings`: typed binding definitions
 * - `workgroupSize`: workgroup dimensions
 *
 * The base class handles:
 * - Shader module creation
 * - Bind group layout creation (from binding definitions)
 * - Pipeline layout and compute pipeline creation
 * - Type-safe bind group creation
 * - Workgroup dispatch math
 */

import { getWebGPU } from "./WebGPUDevice";
import {
  type BindingsDefinition,
  type BindGroupResources,
  createBindGroupLayoutEntries,
  createBindGroupEntries,
} from "./ShaderBindings";

/**
 * Abstract base class for compute shaders.
 *
 * @template T - The bindings definition type for type-safe bind group creation
 */
export abstract class ComputeShader<T extends BindingsDefinition> {
  /** WGSL shader code. Subclasses must provide this. */
  abstract readonly code: string;

  /** Binding definitions. Subclasses must provide this. */
  abstract readonly bindings: T;

  /** Workgroup size [x, y] or [x, y, z]. Subclasses must provide this. */
  abstract readonly workgroupSize:
    | readonly [number, number]
    | readonly [number, number, number];

  /** Label for GPU debugging. Subclasses can override. */
  get label(): string {
    return this.constructor.name;
  }

  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  /**
   * Initialize the compute pipeline.
   * Must be called before dispatch.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: this.code,
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
   * Get the bind group layout for creating bind groups.
   */
  getBindGroupLayout(): GPUBindGroupLayout {
    if (!this.bindGroupLayout) {
      throw new Error(`${this.label} not initialized`);
    }
    return this.bindGroupLayout;
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
   * Create a bind group with type-safe named parameters.
   */
  createBindGroup(resources: BindGroupResources<T>): GPUBindGroup {
    const device = getWebGPU().device;

    return device.createBindGroup({
      layout: this.getBindGroupLayout(),
      entries: createBindGroupEntries(this.bindings, resources),
      label: `${this.label} Bind Group`,
    });
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
