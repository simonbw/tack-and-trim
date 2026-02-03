# Auto-Generated WGSL Bindings Example

The `Shader` class automatically generates WGSL binding declarations from TypeScript binding definitions, ensuring they're always in sync.

## Basic Example

```typescript
import { Shader } from "./Shader";

class MyShader extends Shader<typeof MyShader.BINDINGS> {
  // Define bindings in TypeScript with wgslType
  static readonly BINDINGS = {
    params: { type: "uniform", wgslType: "Params" },
    inputData: { type: "storage", wgslType: "array<f32>" },
    outputData: { type: "storageRW", wgslType: "array<f32>" },
    outputTex: { type: "storageTexture", format: "rgba32float" },
  } as const;

  readonly bindings = MyShader.BINDINGS;

  get label() {
    return "My Shader";
  }

  async init() {
    const device = getWebGPU().device;

    const shaderCode = /*wgsl*/ `
// Struct definitions
struct Params {
  size: u32,
  scale: f32,
}

// Auto-generated bindings (always in sync with TypeScript!)
${this.buildWGSLBindings()}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let value = inputData[id.x];
  outputData[id.x] = value * params.scale;
  textureStore(outputTex, vec2<i32>(id.xy), vec4<f32>(value));
}
    `;

    // Create pipeline...
  }

  destroy() {
    // Cleanup...
  }
}
```

The `buildWGSLBindings()` call above generates:

```wgsl
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> inputData: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputData: array<f32>;
@group(0) @binding(3) var outputTex: texture_storage_2d<rgba32float, write>;
```

## Benefits

1. **Type Safety**: TypeScript knows the exact resource types needed for `createBindGroup()`
2. **Never Out of Sync**: WGSL bindings are generated from the TypeScript definition
3. **Single Source of Truth**: The `BINDINGS` constant defines everything
4. **Refactoring Safety**: Rename or reorder bindings in one place

## With Shader Modules

Modules define their bindings with `wgslType`. Use the `BindingsFromModules` type helper to automatically generate the correct bindings type:

```typescript
// queryPoints.wgsl.ts
export const queryPointsModule: ShaderModule = {
  code: /*wgsl*/ `
    struct QueryPoint {
      pos: vec2<f32>,
    }
  `,
  bindings: {
    queryPoints: {
      type: "storage",
      wgslType: "array<QueryPoint>",
    },
  },
};

// MyShader.ts
import { type BindingsFromModules } from "./ShaderModule";
import { queryPointsModule } from "./queryPoints.wgsl";

class MyShader extends ComputeShader<typeof MyShader.BINDINGS> {
  // Define modules as const array for type inference
  static readonly MODULES = [queryPointsModule] as const;

  // Use helper to merge module bindings with shader-specific bindings
  static readonly BINDINGS = Shader.mergeBindings(MyShader.MODULES, {
    results: { type: "storageRW", wgslType: "array<f32>" },
  });

  readonly bindings = MyShader.BINDINGS;
  protected modules = MyShader.MODULES;

  get label() {
    return "My Shader";
  }

  protected mainCode = /*wgsl*/ `
// Auto-generate ALL bindings (module + shader)
${this.buildWGSLBindings()}

@compute @workgroup_size(64, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let point = queryPoints[id.x];  // From module
  results[id.x] = point.pos.x;    // Write to shader binding
}
  `;
}
```

### Alternative: Manual Type

You can also manually specify the type if you prefer:

```typescript
class MyShader extends ComputeShader<
  BindingsFromModules<
    typeof MyShader.MODULES,
    { results: { type: "storageRW"; wgslType: "array<f32>" } }
  >
> {
  static readonly MODULES = [queryPointsModule] as const;

  readonly bindings = {
    ...queryPointsModule.bindings,
    results: { type: "storageRW", wgslType: "array<f32>" },
  } as const;

  // ...
}
```

## Advanced: Custom Group Numbers

For multi-group shaders:

```typescript
const group0 = this.buildWGSLBindings(
  {
    params: "Params",
  },
  0,
);

const group1 = this.buildWGSLBindings(
  {
    texture: undefined,
    sampler: undefined,
  },
  1,
);
```
