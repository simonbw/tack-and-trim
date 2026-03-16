/**
 * Simple fullscreen shader that composites the offscreen tree texture
 * into the main render pass using premultiplied alpha blending.
 */

import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";

const treeCompositeModule: ShaderModule = {
  bindings: {
    treeTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
  },
  code: /*wgsl*/ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(treeTexture, vec2<i32>(fragCoord.xy), 0);
}
`,
};

const treeCompositeConfig: FullscreenShaderConfig = {
  modules: [treeCompositeModule],
  // Tree texture contains premultiplied alpha from multi-layer blending,
  // so use one/one-minus-src-alpha (premultiplied blend mode).
  blendState: {
    color: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
    alpha: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
  },
  label: "TreeCompositeShader",
};

export function createTreeCompositeShader(): FullscreenShader {
  return new FullscreenShader(treeCompositeConfig);
}
