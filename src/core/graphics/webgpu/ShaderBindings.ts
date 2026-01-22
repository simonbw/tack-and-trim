/**
 * Type definitions for shader bindings.
 *
 * These types provide a declarative way to define shader bindings that can be
 * used to automatically generate bind group layouts and type-safe bind group creation.
 */

/**
 * Binding type for uniform buffers.
 */
export type UniformBinding = {
  type: "uniform";
};

/**
 * Binding type for read-only storage buffers.
 */
export type StorageBinding = {
  type: "storage";
};

/**
 * Binding type for read-write storage buffers.
 */
export type StorageRWBinding = {
  type: "storageRW";
};

/**
 * Binding type for write-only storage textures.
 */
export type StorageTextureBinding = {
  type: "storageTexture";
  format: GPUTextureFormat;
};

/**
 * Binding type for sampled textures.
 */
export type TextureBinding = {
  type: "texture";
  sampleType?: GPUTextureSampleType;
  viewDimension?: GPUTextureViewDimension;
};

/**
 * Binding type for samplers.
 */
export type SamplerBinding = {
  type: "sampler";
  samplerType?: GPUSamplerBindingType;
};

/**
 * Union of all binding types.
 */
export type BindingDefinition =
  | UniformBinding
  | StorageBinding
  | StorageRWBinding
  | StorageTextureBinding
  | TextureBinding
  | SamplerBinding;

/**
 * A record of named binding definitions.
 */
export type BindingsDefinition = Readonly<Record<string, BindingDefinition>>;

/**
 * Maps a binding definition to the resource type expected when creating a bind group.
 */
export type BindingResource<T extends BindingDefinition> =
  T extends UniformBinding
    ? { buffer: GPUBuffer }
    : T extends StorageBinding
      ? { buffer: GPUBuffer }
      : T extends StorageRWBinding
        ? { buffer: GPUBuffer }
        : T extends StorageTextureBinding
          ? GPUTextureView
          : T extends TextureBinding
            ? GPUTextureView
            : T extends SamplerBinding
              ? GPUSampler
              : never;

/**
 * Maps a bindings definition to the expected resources object for createBindGroup.
 */
export type BindGroupResources<T extends BindingsDefinition> = {
  [K in keyof T]: BindingResource<T[K]>;
};

/**
 * Creates a bind group layout entry from a binding definition.
 */
export function createBindGroupLayoutEntry(
  binding: number,
  definition: BindingDefinition,
  visibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry {
  const entry: GPUBindGroupLayoutEntry = {
    binding,
    visibility,
  };

  switch (definition.type) {
    case "uniform":
      entry.buffer = { type: "uniform" };
      break;
    case "storage":
      entry.buffer = { type: "read-only-storage" };
      break;
    case "storageRW":
      entry.buffer = { type: "storage" };
      break;
    case "storageTexture":
      entry.storageTexture = {
        access: "write-only",
        format: definition.format,
        viewDimension: "2d",
      };
      break;
    case "texture":
      entry.texture = {
        sampleType: definition.sampleType ?? "float",
        viewDimension: definition.viewDimension ?? "2d",
      };
      break;
    case "sampler":
      entry.sampler = {
        type: definition.samplerType ?? "filtering",
      };
      break;
  }

  return entry;
}

/**
 * Creates bind group layout entries from a bindings definition.
 */
export function createBindGroupLayoutEntries(
  bindings: BindingsDefinition,
  visibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry[] {
  const keys = Object.keys(bindings);
  return keys.map((key, index) =>
    createBindGroupLayoutEntry(index, bindings[key], visibility),
  );
}

/**
 * Creates bind group entries from resources matching a bindings definition.
 */
export function createBindGroupEntries<T extends BindingsDefinition>(
  bindings: T,
  resources: BindGroupResources<T>,
): GPUBindGroupEntry[] {
  const keys = Object.keys(bindings) as (keyof T)[];
  return keys.map((key, index) => {
    const definition = bindings[key];
    const resource = resources[key];

    if (
      definition.type === "uniform" ||
      definition.type === "storage" ||
      definition.type === "storageRW"
    ) {
      return {
        binding: index,
        resource: resource as GPUBufferBinding,
      };
    } else {
      return {
        binding: index,
        resource: resource as GPUTextureView | GPUSampler,
      };
    }
  });
}
