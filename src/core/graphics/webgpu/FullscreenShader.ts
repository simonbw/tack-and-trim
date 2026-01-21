/**
 * Base class for fullscreen render shaders.
 *
 * Handles GPU pipeline boilerplate so subclasses just declare:
 * - `vertexCode`: WGSL vertex shader code
 * - `fragmentCode`: WGSL fragment shader code
 * - `bindings`: typed binding definitions
 * - Optional: `getBlendState()` override for custom blending
 *
 * The base class handles:
 * - Shader module creation
 * - Bind group layout creation (from binding definitions)
 * - Pipeline layout and render pipeline creation
 * - Fullscreen quad vertex buffer layout
 * - Type-safe bind group creation
 */

import { getWebGPU } from "./WebGPUDevice";
import { WebGPUFullscreenQuad } from "./WebGPUFullscreenQuad";
import {
  type BindingsDefinition,
  type BindGroupResources,
  createBindGroupLayoutEntries,
  createBindGroupEntries,
} from "./ShaderBindings";

/**
 * Abstract base class for fullscreen render shaders.
 *
 * @template T - The bindings definition type for type-safe bind group creation
 */
export abstract class FullscreenShader<T extends BindingsDefinition> {
  /** WGSL vertex shader code. Subclasses must provide this. */
  abstract readonly vertexCode: string;

  /** WGSL fragment shader code. Subclasses must provide this. */
  abstract readonly fragmentCode: string;

  /** Binding definitions. Subclasses must provide this. */
  abstract readonly bindings: T;

  /** Label for GPU debugging. Subclasses can override. */
  get label(): string {
    return this.constructor.name;
  }

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private quad: WebGPUFullscreenQuad | null = null;

  /**
   * Get the blend state for this shader. Override to customize.
   * Returns undefined for opaque (no blending).
   */
  protected getBlendState(): GPUBlendState | undefined {
    return undefined;
  }

  /**
   * Get the render target format. Override if using a custom format.
   */
  protected getTargetFormat(): GPUTextureFormat {
    return getWebGPU().preferredFormat;
  }

  /**
   * Initialize the render pipeline.
   * Must be called before render.
   */
  async init(): Promise<void> {
    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: this.vertexCode + "\n" + this.fragmentCode,
      label: `${this.label} Shader Module`,
    });

    // Create bind group layout from binding definitions
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

    const blendState = this.getBlendState();

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
            blend: blendState,
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
   * Get the bind group layout for creating bind groups.
   */
  getBindGroupLayout(): GPUBindGroupLayout {
    if (!this.bindGroupLayout) {
      throw new Error(`${this.label} not initialized`);
    }
    return this.bindGroupLayout;
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
