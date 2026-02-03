/**
 * Base class for fullscreen render shaders.
 *
 * Handles GPU pipeline boilerplate so subclasses just declare:
 * - `vertexCode`: WGSL vertex shader code (or use vertexModules + vertexMainCode)
 * - `fragmentCode`: WGSL fragment shader code (or use fragmentModules + fragmentMainCode)
 * - `bindings`: typed binding definitions
 * - Optional: `getBlendState()` override for custom blending
 *
 * The base class handles:
 * - Shader module creation
 * - Bind group layout creation (from binding definitions)
 * - Pipeline layout and render pipeline creation
 * - Fullscreen quad vertex buffer layout
 * - Type-safe bind group creation
 *
 * Module Support:
 * - Set `vertexModules` and `vertexMainCode` to compose vertex shader
 * - Set `fragmentModules` and `fragmentMainCode` to compose fragment shader
 * - Or use `vertexCode` and `fragmentCode` directly for backwards compatibility
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
 * Abstract base class for fullscreen render shaders.
 *
 * @template T - The bindings definition type for type-safe bind group creation
 */
export abstract class FullscreenShader<
  T extends BindingsDefinition,
> extends Shader<T> {
  /** WGSL vertex shader code. Optional when using modules. */
  vertexCode?: string;

  /** WGSL fragment shader code. Optional when using modules. */
  fragmentCode?: string;

  /** Vertex shader modules. */
  protected vertexModules?: ShaderModule[];

  /** Fragment shader modules. */
  protected fragmentModules?: ShaderModule[];

  /** Main vertex code when using modules. */
  protected vertexMainCode?: string;

  /** Main fragment code when using modules. */
  protected fragmentMainCode?: string;

  /** Label for GPU debugging. Subclasses can override. */
  get label(): string {
    return this.constructor.name;
  }

  private pipeline: GPURenderPipeline | null = null;
  private quad: WebGPUFullscreenQuad | null = null;

  /**
   * Override to combine vertex and fragment modules.
   */
  protected collectModules(): ShaderModule[] {
    const allModules = [
      ...(this.vertexModules ?? []),
      ...(this.fragmentModules ?? []),
    ];

    if (allModules.length === 0) return [];

    const seen = new Set<ShaderModule>();
    const ordered: ShaderModule[] = [];

    function collect(module: ShaderModule) {
      if (seen.has(module)) return;
      seen.add(module);

      for (const dep of module.dependencies ?? []) {
        collect(dep);
      }

      ordered.push(module);
    }

    for (const module of allModules) {
      collect(module);
    }

    return ordered;
  }

  /**
   * Get vertex shader code (just the main code, without modules).
   */
  protected getVertexMainCodeOnly(): string {
    if (this.vertexCode) {
      return this.vertexCode;
    }
    if (this.vertexMainCode) {
      return this.vertexMainCode;
    }
    throw new Error(
      `${this.label}: Must provide either 'vertexCode' or 'vertexMainCode'`,
    );
  }

  /**
   * Get fragment shader code (just the main code, without modules).
   */
  protected getFragmentMainCodeOnly(): string {
    if (this.fragmentCode) {
      return this.fragmentCode;
    }
    if (this.fragmentMainCode) {
      return this.fragmentMainCode;
    }
    throw new Error(
      `${this.label}: Must provide either 'fragmentCode' or 'fragmentMainCode'`,
    );
  }

  /**
   * Build all module code once (combining vertex and fragment modules).
   */
  protected buildAllModuleCode(): string {
    const modules = this.collectModules();
    const parts: string[] = [];

    // Add all module code
    for (const module of modules) {
      parts.push(module.code);
    }

    return parts.join("\n\n");
  }

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

    // Build complete shader:
    // 1. Math constants (once)
    // 2. All modules (vertex + fragment, deduplicated, once)
    // 3. Vertex main code
    // 4. Fragment main code
    const completeShaderCode =
      this.getMathConstants() +
      "\n\n" +
      this.buildAllModuleCode() +
      "\n\n" +
      this.getVertexMainCodeOnly() +
      "\n\n" +
      this.getFragmentMainCodeOnly();

    const shaderModule = device.createShaderModule({
      code: completeShaderCode,
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
