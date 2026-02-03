import type { BindingsDefinition } from "./ShaderBindings";
import { generateWGSLBindings } from "./ShaderBindings";

/**
 * A reusable WGSL code module that can be composed into shaders.
 *
 * Modules can declare:
 * - WGSL code (functions, structs, constants)
 * - GPU bindings they require
 * - Dependencies on other modules
 *
 * The shader system automatically:
 * - Resolves dependencies in correct order
 * - Deduplicates shared dependencies
 * - Merges bindings from all modules
 */
export interface ShaderModule {
  /** WGSL code for this module */
  code: string;

  /** Bindings this module requires */
  bindings?: BindingsDefinition;

  /** Other modules this depends on (will be included before this module) */
  dependencies?: ShaderModule[];
}

/**
 * Extract the bindings definition from a shader module.
 * Returns an empty object if the module has no bindings.
 */
export type ModuleBindings<M extends ShaderModule> = M extends {
  bindings: infer B;
}
  ? B
  : {};

/**
 * Merge bindings from multiple modules into a single bindings definition.
 * Later modules override earlier ones if binding names conflict.
 */
export type MergeModuleBindings<Modules extends readonly ShaderModule[]> =
  Modules extends readonly [infer First extends ShaderModule, ...infer Rest]
    ? Rest extends readonly ShaderModule[]
      ? ModuleBindings<First> & MergeModuleBindings<Rest>
      : ModuleBindings<First>
    : {};

/**
 * Create a bindings definition from modules plus additional shader-specific bindings.
 *
 * @example
 * const modules = [queryPointsModule, waterModule] as const;
 *
 * type MyBindings = BindingsFromModules<typeof modules, {
 *   results: { type: "storageRW", wgslType: "array<f32>" }
 * }>;
 */
export type BindingsFromModules<
  Modules extends readonly ShaderModule[],
  Additional extends BindingsDefinition = {},
> = MergeModuleBindings<Modules> & Additional;

/**
 * Generate WGSL binding declarations for a shader module.
 *
 * Useful when you want to include a module's bindings in shader code.
 *
 * @param module - The shader module
 * @param group - Group number (default: 0)
 * @returns WGSL code declaring the module's bindings
 */
export function generateModuleBindings(
  module: ShaderModule,
  group: number = 0,
): string {
  if (!module.bindings) {
    return "";
  }
  return generateWGSLBindings(module.bindings, group);
}
