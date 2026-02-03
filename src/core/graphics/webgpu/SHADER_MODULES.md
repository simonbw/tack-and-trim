# Shader Module System

A composable shader module system for sharing WGSL code across shaders.

## Overview

The shader module system allows you to:
- Write WGSL functions once and import them in multiple shaders
- Automatically resolve dependencies between modules
- Merge bindings from all modules
- Maintain backwards compatibility with direct-code shaders

## Architecture

### Core Types

**ShaderModule** (`ShaderModule.ts`):
```typescript
interface ShaderModule {
  code: string;                    // WGSL source code
  bindings?: BindingsDefinition;   // Required GPU bindings
  dependencies?: ShaderModule[];   // Other modules this depends on
}
```

**Shader** (`Shader.ts`):
Base class providing:
- Module collection with deduplication
- Code building from modules
- Binding merging
- Shared bind group methods

**ComputeShader** and **FullscreenShader**:
Extended to support both:
- Direct code (backwards compatible)
- Module-based composition (new feature)

## Usage

### Creating Shader Modules

Create reusable WGSL code as TypeScript modules. Bindings include their WGSL type:

```typescript
// terrain.wgsl.ts
export const terrainHeightModule: ShaderModule = {
  code: /*wgsl*/`
    fn calculateTerrainHeight(worldPos: vec2<f32>) -> f32 {
      // ... terrain calculation ...
      return height;
    }
  `,
  bindings: {
    terrainContours: {
      type: 'storage',
      wgslType: 'array<ContourData>',
    },
    controlPoints: {
      type: 'storage',
      wgslType: 'array<vec2<f32>>',
    },
  }
};
```

### Using Modules with Dependencies

Modules can depend on other modules:

```typescript
// water.wgsl.ts
import { terrainHeightModule } from './terrain.wgsl';

export const waterDataModule: ShaderModule = {
  code: /*wgsl*/`
    fn calculateWaterData(worldPos: vec2<f32>) -> vec4<f32> {
      let terrainH = calculateTerrainHeight(worldPos);  // From dependency
      // ... water calculation using terrain height ...
      return waterData;
    }
  `,
  bindings: {
    waveSources: {
      type: 'storage',
      wgslType: 'array<WaveSource>',
    },
    waterParams: {
      type: 'uniform',
      wgslType: 'WaterParams',
    },
  },
  dependencies: [terrainHeightModule]  // Automatic inclusion
};
```

### Using Modules in Compute Shaders

**Recommended approach with type helpers**:
```typescript
import { type BindingsFromModules } from './ShaderModule';
import { waterDataModule } from './water.wgsl';

class MyComputeShader extends ComputeShader<typeof MyComputeShader.BINDINGS> {
  // Define modules as const for type inference
  static readonly MODULES = [waterDataModule] as const;

  // Use helper to merge bindings (automatically typed!)
  static readonly BINDINGS = Shader.mergeBindings(MyComputeShader.MODULES, {
    results: { type: 'storageRW', wgslType: 'array<f32>' }
  });

  readonly bindings = MyComputeShader.BINDINGS;
  protected modules = MyComputeShader.MODULES;

  protected mainCode = /*wgsl*/`
    ${this.buildWGSLBindings()}  // Auto-generates all bindings

    @compute @workgroup_size(64, 1)
    fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
      let data = calculateWaterData(pos);  // From module
      results[globalId.x] = data.x;
    }
  `;

  readonly workgroupSize = [64, 1] as const;
}
```

**Old direct-code approach (still works)**:
```typescript
class MyComputeShader extends ComputeShader<typeof MyBindings> {
  readonly code = /*wgsl*/`
    // All WGSL code here
    @compute @workgroup_size(64, 1)
    fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
      // ...
    }
  `;

  readonly bindings = MyBindings;
  readonly workgroupSize = [64, 1] as const;
}
```

### Using Modules in Fullscreen Shaders

Fullscreen shaders can have separate modules for vertex and fragment:

```typescript
import { waterDataModule } from './water.wgsl';

class MyFullscreenShader extends FullscreenShader<typeof MyBindings> {
  protected vertexModules = [];  // No modules needed for simple vertex
  protected fragmentModules = [waterDataModule];

  protected vertexMainCode = /*wgsl*/`
    @vertex
    fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
      // ... vertex shader ...
    }
  `;

  protected fragmentMainCode = /*wgsl*/`
    @fragment
    fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
      let data = calculateWaterData(pos);  // From module
      return color;
    }
  `;

  readonly bindings = {
    ...this.buildBindings(),  // From modules
    // Additional bindings
  } as const;
}
```

## How It Works

### Module Collection

1. Depth-first traversal of dependency tree
2. Deduplication using Set (same module included once)
3. Dependencies ordered before dependents (WGSL requires this)

### Code Building

1. Collect all modules in dependency order
2. Concatenate module code with `\n\n` separator
3. Append main code at the end
4. Return complete WGSL shader

### Binding Merging

1. Iterate through modules in order
2. Merge all bindings using `Object.assign`
3. Later modules override earlier ones (avoid name conflicts!)
4. Return merged bindings definition

## Auto-Generated WGSL Bindings

Binding definitions include their WGSL type, allowing automatic generation of binding declarations. This ensures TypeScript and WGSL are never out of sync.

### Example

```typescript
class MyShader extends ComputeShader<typeof MyShader.BINDINGS> {
  static readonly BINDINGS = {
    params: { type: "uniform", wgslType: "Params" },
    inputData: { type: "storage", wgslType: "array<f32>" },
    outputTex: { type: "storageTexture", format: "rgba32float" },
  } as const;

  readonly bindings = MyShader.BINDINGS;

  protected mainCode = /*wgsl*/`
    // Struct definitions
    struct Params {
      size: u32,
      scale: f32,
    }

    // Auto-generated bindings - always in sync!
    ${this.buildWGSLBindings()}

    @compute @workgroup_size(64, 1)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let value = inputData[id.x];
      textureStore(outputTex, vec2<i32>(id.xy), vec4<f32>(value));
    }
  `;
}
```

This generates:
```wgsl
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> inputData: array<f32>;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba32float, write>;
```

### With Modules

When using modules, their bindings are automatically included:

```typescript
import { queryPointsModule } from './common.wgsl';

class MyShader extends ComputeShader<typeof MyShader.BINDINGS> {
  static readonly BINDINGS = {
    ...queryPointsModule.bindings,  // Module bindings
    results: { type: "storageRW", wgslType: "array<f32>" },
  } as const;

  readonly bindings = MyShader.BINDINGS;
  protected modules = [queryPointsModule];

  protected mainCode = /*wgsl*/`
    // One call generates ALL bindings (module + shader)
    ${this.buildWGSLBindings()}

    @compute @workgroup_size(64, 1)
    fn main() {
      let point = queryPoints[0];  // From module
      results[0] = point.pos.x;    // Shader binding
    }
  `;
}
```

### Benefits

- **Type Safety**: `createBindGroup()` knows exactly what resources are needed
- **Single Source of Truth**: Each binding's WGSL type is defined once
- **Refactoring Safety**: Change binding order or types in one place
- **No Manual Sync**: Bindings cannot drift between TypeScript and WGSL
- **Module Composability**: Modules bring their type information with them

See `SHADER_BINDINGS_EXAMPLE.md` for more details.

## Best Practices

### Naming Conventions

Avoid binding name conflicts between modules:
- Prefix bindings with module name: `waterParams`, `terrainContours`
- Use descriptive names: `waveSources` not `sources`

### Module Organization

- Keep modules focused and single-purpose
- Put common utilities in shared modules
- Use TypeScript imports for type safety

### File Structure

```
src/game/world/shaders/
  common.wgsl.ts      # Shared utilities (query points, etc.)
  terrain.wgsl.ts     # Terrain height functions
  water.wgsl.ts       # Water wave functions
  wind.wgsl.ts        # Wind field functions
```

### Backwards Compatibility

All existing shaders continue to work without changes:
- ComputeShader: Use `code` property
- FullscreenShader: Use `vertexCode` and `fragmentCode` properties

## Example Modules

See `src/game/world/shaders/` for examples:
- `common.wgsl.ts` - Query point structure
- `terrain.wgsl.ts` - Terrain height calculation
- `water.wgsl.ts` - Water data calculation with terrain dependency

## Technical Details

### Deduplication Algorithm

```typescript
protected collectModules(): ShaderModule[] {
  const seen = new Set<ShaderModule>();
  const ordered: ShaderModule[] = [];

  function collect(module: ShaderModule) {
    if (seen.has(module)) return;  // Skip if already seen
    seen.add(module);

    // Collect dependencies first (depth-first)
    for (const dep of module.dependencies ?? []) {
      collect(dep);
    }

    ordered.push(module);
  }

  for (const module of this.modules) {
    collect(module);
  }

  return ordered;
}
```

### FullscreenShader Module Collection

Combines both vertex and fragment modules before deduplication:

```typescript
protected collectModules(): ShaderModule[] {
  const allModules = [
    ...(this.vertexModules ?? []),
    ...(this.fragmentModules ?? [])
  ];
  // ... same deduplication logic
}
```

## Limitations

- **No circular dependencies**: Circular module dependencies are not supported
- **No binding conflict detection**: Duplicate binding names will silently override
- **Object identity for deduplication**: Same module object must be used (not deep equality)

## Future Enhancements

- Binding conflict warnings
- Automatic binding index assignment
- WGSL validation
- Module caching
- Dependency graph visualization
