/**
 * Base class for shaders with module composition support.
 *
 * Shaders are built from composable modules. Each module can provide:
 * - preamble: struct definitions (before bindings)
 * - bindings: GPU resource bindings
 * - code: functions, constants, entry points (after bindings)
 *
 * The shader automatically:
 * - Resolves module dependencies in correct order
 * - Deduplicates shared dependencies
 * - Merges bindings from all modules
 * - Builds code in correct order: preambles → bindings → code
 */

import {
  type BindGroupResources,
  type BindingsDefinition,
  createBindGroupEntries,
  generateWGSLBindings,
} from "./ShaderBindings";
import type { MergeModuleBindings, ShaderModule } from "./ShaderModule";
import { getWebGPU } from "./WebGPUDevice";

/**
 * Abstract base class for all shaders.
 *
 * @template T - The bindings definition type for type-safe bind group creation
 */
export abstract class Shader<T extends BindingsDefinition> {
  /** Optional modules to compose into this shader */
  protected modules?: ShaderModule[];

  /** Bind group layout (created during init) */
  protected bindGroupLayout: GPUBindGroupLayout | null = null;

  /** Label for GPU debugging */
  abstract get label(): string;

  /** Binding definitions. Subclasses must provide this. */
  abstract readonly bindings: T;

  /** Initialize GPU resources. Subclasses must implement. */
  abstract init(): Promise<void>;

  /** Clean up GPU resources. Subclasses must implement. */
  abstract destroy(): void;

  /**
   * Collect all modules and their dependencies in correct order.
   * Uses depth-first traversal to ensure dependencies come before dependents.
   * Deduplicates shared dependencies.
   */
  protected collectModules(): ShaderModule[] {
    if (!this.modules) return [];

    const seen = new Set<ShaderModule>();
    const ordered: ShaderModule[] = [];

    function collect(module: ShaderModule) {
      if (!seen.has(module)) {
        seen.add(module);
        // Collect dependencies first (depth-first)
        module.dependencies?.forEach(collect);
        // Add module after dependencies
        ordered.push(module);
      }
    }

    this.modules.forEach(collect);

    return ordered;
  }

  /**
   * Get the standard math and physics constants that should be included once per shader.
   * @returns WGSL code for fundamental constants
   */
  protected getMathConstants(): string {
    return /*wgsl*/ `
// Fundamental constants (included automatically)
const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;
const GRAVITY: f32 = 32.174; // ft/s^2
    `;
  }

  /**
   * Build complete WGSL code from modules.
   * Order: preambles → auto-generated bindings → code
   *
   * @returns Complete WGSL shader code (without math constants - those are added by the shader class)
   */
  protected buildCode(): string {
    const modules = this.collectModules();

    // 1. Collect preambles (structs needed by bindings)
    const preambles = modules
      .filter((m) => m.preamble)
      .map((m) => m.preamble)
      .join("\n\n");

    // 2. Auto-generate binding declarations
    const bindingsWgsl = this.buildBindingsWgsl();

    // 3. Collect module code (functions, constants, entry points)
    const code = modules.map((m) => m.code).join("\n\n");

    return [preambles, bindingsWgsl, code].filter(Boolean).join("\n\n");
  }

  /**
   * Build merged bindings from all modules.
   * Later modules override earlier ones if binding names conflict.
   *
   * @returns Merged bindings definition
   */
  protected buildBindings(): BindingsDefinition {
    const modules = this.collectModules();
    const merged: Record<string, any> = {};

    for (const module of modules) {
      if (module.bindings) {
        Object.assign(merged, module.bindings);
      }
    }

    return merged;
  }

  /**
   * Helper to merge module bindings with additional shader-specific bindings.
   * Use this with the BindingsFromModules type helper.
   *
   * @param modules - Array of shader modules
   * @param additional - Additional shader-specific bindings
   * @returns Merged bindings definition
   *
   * @example
   * static readonly MODULES = [queryPointsModule, waterModule] as const;
   * static readonly BINDINGS = Shader.mergeBindings(MyShader.MODULES, {
   *   results: { type: "storageRW", wgslType: "array<f32>" }
   * });
   */
  protected static mergeBindings<
    Modules extends readonly ShaderModule[],
    Additional extends BindingsDefinition,
  >(modules: Modules, additional: Additional) {
    const merged: Record<string, any> = {};

    for (const module of modules) {
      if (module.bindings) {
        Object.assign(merged, module.bindings);
      }
    }

    Object.assign(merged, additional);
    return merged as MergeModuleBindings<Modules> & Additional;
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
   * Generate WGSL binding declarations from the TypeScript bindings definition.
   *
   * This ensures the WGSL and TypeScript are always in sync.
   *
   * @param group - Group number (default: 0)
   * @returns WGSL code declaring the bindings
   *
   * @example
   * const wgsl = this.buildBindingsWgsl();
   */
  protected buildBindingsWgsl(group: number = 0): string {
    return generateWGSLBindings(this.bindings, group);
  }
}
