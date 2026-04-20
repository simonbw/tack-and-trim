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

import { getMSAASampleCount, onMSAAChange } from "./MSAAState";
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

  /** Depth stencil state for depth buffer interaction (undefined = no depth) */
  depthStencilState?: GPUDepthStencilState;

  /**
   * Opt out of automatic MSAA tracking. By default FullscreenShader uses
   * the current main-pass MSAA sample count (from MSAAState) and rebuilds
   * its pipeline when the user toggles MSAA. Pass true for offscreen uses.
   */
  disableMSAA?: boolean;

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
  private readonly depthStencilState?: GPUDepthStencilState;
  private readonly disableMSAA: boolean;

  private pipeline: GPURenderPipeline | null = null;
  private quad: WebGPUFullscreenQuad | null = null;

  // Cached inputs for sync MSAA rebuild.
  private shaderModule: GPUShaderModule | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private unsubscribeMSAA: (() => void) | null = null;

  constructor(config: FullscreenShaderConfig) {
    super();
    this.modules = config.modules;
    this._label = config.label ?? "FullscreenShader";
    this.blendState = config.blendState;
    this.targetFormat = config.targetFormat;
    // Default: depth-compatible no-op (always pass, no write) since the main render
    // pass has a depth attachment. Override with explicit depthStencilState for
    // depth-writing shaders, or set to undefined for offscreen-only shaders.
    this.depthStencilState = config.depthStencilState ?? {
      format: "depth24plus",
      depthCompare: "always",
      depthWriteEnabled: false,
    };
    this.disableMSAA = config.disableMSAA ?? false;
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
    const gpu = getWebGPU();
    const device = gpu.device;

    // Build complete shader with math constants at the top
    const completeShaderCode =
      this.getMathConstants() + "\n\n" + this.buildCode();

    this.shaderModule = await gpu.createShaderModuleChecked(
      completeShaderCode,
      `${this.label} Shader Module`,
    );

    // Create bind group layout from merged bindings
    // Use both VERTEX and FRAGMENT visibility for flexibility
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: createBindGroupLayoutEntries(
        this.bindings,
        GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      ),
      label: `${this.label} Bind Group Layout`,
    });

    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: `${this.label} Pipeline Layout`,
    });

    this.rebuildPipeline();
    this.quad = new WebGPUFullscreenQuad();

    if (!this.disableMSAA) {
      this.unsubscribeMSAA = onMSAAChange(() => this.rebuildPipeline());
    }
  }

  /**
   * Recreate the render pipeline using cached shader/layout inputs and the
   * current MSAA sample count. Cheap; called on MSAA toggle.
   */
  private rebuildPipeline(): void {
    const gpu = getWebGPU();
    const device = gpu.device;
    if (!this.shaderModule || !this.pipelineLayout) return;

    const multisample: GPUMultisampleState | undefined = this.disableMSAA
      ? undefined
      : { count: getMSAASampleCount() };

    this.pipeline = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [WebGPUFullscreenQuad.getVertexBufferLayout()],
      },
      fragment: {
        module: this.shaderModule,
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
      depthStencil: this.depthStencilState,
      multisample,
      label: `${this.label} Render Pipeline`,
    });
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
    this.unsubscribeMSAA?.();
    this.unsubscribeMSAA = null;
    this.quad?.destroy();
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.pipelineLayout = null;
    this.shaderModule = null;
    this.quad = null;
  }
}
