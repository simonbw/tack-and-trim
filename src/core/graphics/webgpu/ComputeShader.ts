/**
 * Compute shader built from composable modules.
 *
 * Create a compute shader by providing:
 * - `modules`: array of shader modules (last one typically contains entry point)
 * - `workgroupSize`: workgroup dimensions for dispatch
 *
 * The shader automatically:
 * - Resolves module dependencies
 * - Merges bindings from all modules
 * - Builds code in correct order: preambles → bindings → code
 */

import { getWebGPU } from "./WebGPUDevice";
import { collectShaderModules, Shader, SHADER_MATH_CONSTANTS } from "./Shader";
import {
  type BindingsDefinition,
  createBindGroupLayoutEntries,
  generateWGSLBindings,
} from "./ShaderBindings";
import type { ShaderModule } from "./ShaderModule";

/**
 * Configuration for creating a compute shader.
 */
export interface ComputeShaderConfig {
  /** Shader modules to compose (last one typically contains entry point) */
  modules: ShaderModule[];

  /** Workgroup size [x, y] or [x, y, z] for dispatch calculations */
  workgroupSize: readonly [number, number] | readonly [number, number, number];

  /** Label for GPU debugging (optional) */
  label?: string;
}

/**
 * Assemble complete WGSL code for a compute shader without requiring a GPU device.
 * Useful for testing shader code in Node.js environments.
 */
export function assembleComputeShaderWGSL(config: ComputeShaderConfig): string {
  const modules = collectShaderModules(config.modules);

  // Collect preambles
  const preambles = modules
    .filter((m) => m.preamble)
    .map((m) => m.preamble)
    .join("\n\n");

  // Merge bindings from all modules
  const merged: Record<string, any> = {};
  for (const module of modules) {
    if (module.bindings) {
      Object.assign(merged, module.bindings);
    }
  }
  const bindingsWgsl = generateWGSLBindings(merged as BindingsDefinition, 0);

  // Collect code
  const code = modules.map((m) => m.code).join("\n\n");

  return [SHADER_MATH_CONSTANTS, preambles, bindingsWgsl, code]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Compute shader built from composable modules.
 */
export class ComputeShader extends Shader<BindingsDefinition> {
  readonly workgroupSize:
    | readonly [number, number]
    | readonly [number, number, number];

  private readonly _label: string;
  private pipeline: GPUComputePipeline | null = null;

  constructor(config: ComputeShaderConfig) {
    super();
    this.modules = config.modules;
    this.workgroupSize = config.workgroupSize;
    this._label = config.label ?? "ComputeShader";
  }

  get label(): string {
    return this._label;
  }

  /**
   * Bindings merged from all modules.
   */
  get bindings(): BindingsDefinition {
    return this.buildBindings();
  }

  /**
   * Initialize the compute pipeline.
   * Must be called before dispatch.
   */
  async init(): Promise<void> {
    const gpu = getWebGPU();
    const device = gpu.device;

    // Build complete shader with math constants at the top
    const completeShaderCode =
      this.getMathConstants() + "\n\n" + this.buildCode();

    const shaderModule = await gpu.createShaderModuleChecked(
      completeShaderCode,
      `${this.label} Shader Module`,
    );

    // Create bind group layout from merged bindings
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
