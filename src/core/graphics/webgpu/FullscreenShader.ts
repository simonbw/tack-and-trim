/**
 * Fullscreen render shader built from composable modules.
 *
 * Create a fullscreen shader by providing:
 * - `modules`: array of shader modules (last one typically contains vs_main and fs_main)
 * - Optional: `blendState`, `targetFormat`, `label`
 *
 * The shader automatically:
 * - Resolves module dependencies
 * - Merges bindings from all modules
 * - Builds code in correct order: preambles → bindings → code
 */

import { getWebGPU } from "./WebGPUDevice";
import { WebGPUFullscreenQuad } from "./WebGPUFullscreenQuad";
import { Shader } from "./Shader";
import type { ShaderModule } from "./ShaderModule";
import {
  type BindingsDefinition,
  createBindGroupLayoutEntries,
} from "./ShaderBindings";

/**
 * Configuration for creating a fullscreen shader.
 */
export interface FullscreenShaderConfig {
  /** Shader modules to compose (last one typically contains entry points) */
  modules: ShaderModule[];

  /** Blend state for alpha blending (undefined = opaque) */
  blendState?: GPUBlendState;

  /** Render target format (defaults to preferred format) */
  targetFormat?: GPUTextureFormat;

  /** Label for GPU debugging (optional) */
  label?: string;
}

/**
 * Fullscreen shader built from composable modules.
 */
export class FullscreenShader extends Shader<BindingsDefinition> {
  private readonly _label: string;
  private readonly blendState?: GPUBlendState;
  private readonly targetFormat?: GPUTextureFormat;

  private pipeline: GPURenderPipeline | null = null;
  private quad: WebGPUFullscreenQuad | null = null;

  constructor(config: FullscreenShaderConfig) {
    super();
    this.modules = config.modules;
    this._label = config.label ?? "FullscreenShader";
    this.blendState = config.blendState;
    this.targetFormat = config.targetFormat;
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
   * Get the render target format.
   */
  getTargetFormat(): GPUTextureFormat {
    return this.targetFormat ?? getWebGPU().preferredFormat;
  }

  /**
   * Initialize the render pipeline.
   * Must be called before render.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Build complete shader with math constants at the top
    const completeShaderCode =
      this.getMathConstants() + "\n\n" + this.buildCode();

    const shaderModule = device.createShaderModule({
      code: completeShaderCode,
      label: `${this.label} Shader Module`,
    });

    // Create bind group layout from merged bindings
    // Use both VERTEX and FRAGMENT visibility for flexibility
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: createBindGroupLayoutEntries(
        this.bindings,
        GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      ),
      label: `${this.label} Bind Group Layout`,
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: `${this.label} Pipeline Layout`,
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [WebGPUFullscreenQuad.getVertexBufferLayout()],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.getTargetFormat(),
            blend: this.blendState,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      label: `${this.label} Render Pipeline`,
    });

    // Create fullscreen quad
    this.quad = new WebGPUFullscreenQuad();
  }

  /**
   * Get the render pipeline.
   */
  getPipeline(): GPURenderPipeline {
    if (!this.pipeline) {
      throw new Error(`${this.label} not initialized`);
    }
    return this.pipeline;
  }

  /**
   * Render the fullscreen shader.
   *
   * @param renderPass - The render pass to render on
   * @param bindGroup - Bind group with resources
   */
  render(renderPass: GPURenderPassEncoder, bindGroup: GPUBindGroup): void {
    if (!this.pipeline || !this.quad) {
      console.warn(`${this.label} not initialized`);
      return;
    }

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, bindGroup);
    this.quad.render(renderPass);
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.quad?.destroy();
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.quad = null;
  }
}
