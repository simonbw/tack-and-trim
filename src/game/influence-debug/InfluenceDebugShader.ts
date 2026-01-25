/**
 * Fullscreen shader for influence field debug visualization.
 *
 * Renders influence field data as a colored overlay by sampling from
 * the pre-computed GPU textures. Much faster than the Draw API approach
 * since it uses a single draw call instead of thousands of fillRect calls.
 *
 * Supports visualization modes:
 * - Mode 1: Depth grid (land/water/shoreline)
 * - Mode 2: Long swell energy (red=blocked, green=exposed)
 * - Mode 3: Short chop energy
 * - Mode 4: Fetch distance (purple=short, yellow=long)
 *
 * Wind influence is not supported (no GPU texture available).
 */

import { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";

const bindings = {
  uniforms: { type: "uniform" },
  influenceSampler: { type: "sampler" },
  swellTexture: { type: "texture", viewDimension: "3d" },
  fetchTexture: { type: "texture", viewDimension: "3d" },
  depthTexture: { type: "texture" },
} as const;

/**
 * Uniform buffer layout (must be 16-byte aligned):
 * - viewportBounds: vec4<f32> (left, top, width, height)
 * - swellGridOrigin: vec2<f32>
 * - swellGridSize: vec2<f32> (cellsX * cellSize, cellsY * cellSize)
 * - fetchGridOrigin: vec2<f32>
 * - fetchGridSize: vec2<f32>
 * - depthGridOrigin: vec2<f32>
 * - depthGridSize: vec2<f32>
 * - mode: i32 (1=depth, 2=swellLong, 3=swellShort, 4=fetch)
 * - directionIndex: i32
 * - directionCount: i32
 * - padding: i32
 */
export const UNIFORM_SIZE = 80; // 20 floats * 4 bytes

export class InfluenceDebugShader extends FullscreenShader<typeof bindings> {
  readonly bindings = bindings;

  readonly vertexCode = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPos: vec2<f32>,
}

@vertex
fn vs_main(@location(0) pos: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.clipPos = pos;
  return out;
}
`;

  readonly fragmentCode = /* wgsl */ `
struct Uniforms {
  viewportBounds: vec4<f32>,  // left, top, width, height
  swellGridOrigin: vec2<f32>,
  swellGridSize: vec2<f32>,
  fetchGridOrigin: vec2<f32>,
  fetchGridSize: vec2<f32>,
  depthGridOrigin: vec2<f32>,
  depthGridSize: vec2<f32>,
  mode: i32,
  directionIndex: i32,
  directionCount: i32,
  _padding: i32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var influenceSampler: sampler;
@group(0) @binding(2) var swellTexture: texture_3d<f32>;
@group(0) @binding(3) var fetchTexture: texture_3d<f32>;
@group(0) @binding(4) var depthTexture: texture_2d<f32>;

const PI: f32 = 3.14159265359;
const DIM_ALPHA: f32 = 0.4;
const CELL_ALPHA: f32 = 0.6;

// Colors
const WATER_COLOR: vec3<f32> = vec3<f32>(0.2, 0.4, 0.667);
const LAND_COLOR: vec3<f32> = vec3<f32>(0.545, 0.412, 0.078);
const SHORELINE_COLOR: vec3<f32> = vec3<f32>(1.0, 0.933, 0.333);
const BLOCKED_COLOR: vec3<f32> = vec3<f32>(0.9, 0.1, 0.1);
const EXPOSED_COLOR: vec3<f32> = vec3<f32>(0.1, 0.9, 0.1);
const SHORT_FETCH_COLOR: vec3<f32> = vec3<f32>(0.3, 0.1, 0.5);
const LONG_FETCH_COLOR: vec3<f32> = vec3<f32>(1.0, 0.9, 0.2);

fn worldToDepthUV(worldPos: vec2<f32>) -> vec2<f32> {
  return (worldPos - uniforms.depthGridOrigin) / uniforms.depthGridSize;
}

fn worldToSwellUVW(worldPos: vec2<f32>, dirIndex: i32) -> vec3<f32> {
  let uv = (worldPos - uniforms.swellGridOrigin) / uniforms.swellGridSize;
  let w = (f32(dirIndex) + 0.5) / f32(uniforms.directionCount);
  return vec3<f32>(uv, w);
}

fn worldToFetchUVW(worldPos: vec2<f32>, dirIndex: i32) -> vec3<f32> {
  let uv = (worldPos - uniforms.fetchGridOrigin) / uniforms.fetchGridSize;
  let w = (f32(dirIndex) + 0.5) / f32(uniforms.directionCount);
  return vec3<f32>(uv, w);
}

fn sampleDepth(worldPos: vec2<f32>) -> f32 {
  let uv = worldToDepthUV(worldPos);
  return textureSample(depthTexture, influenceSampler, uv).r;
}

fn sampleSwell(worldPos: vec2<f32>, dirIndex: i32) -> vec4<f32> {
  let uvw = worldToSwellUVW(worldPos, dirIndex);
  return textureSample(swellTexture, influenceSampler, uvw);
}

fn sampleFetch(worldPos: vec2<f32>, dirIndex: i32) -> f32 {
  let uvw = worldToFetchUVW(worldPos, dirIndex);
  return textureSample(fetchTexture, influenceSampler, uvw).r;
}

fn renderDepthMode(worldPos: vec2<f32>) -> vec4<f32> {
  let depth = sampleDepth(worldPos);

  var color: vec3<f32>;
  if (abs(depth) < 1.0) {
    // Shoreline
    color = SHORELINE_COLOR;
  } else if (depth < 0.0) {
    // Water
    color = WATER_COLOR;
  } else {
    // Land
    color = LAND_COLOR;
  }

  return vec4<f32>(color, CELL_ALPHA);
}

fn renderSwellMode(worldPos: vec2<f32>, isLongSwell: bool) -> vec4<f32> {
  let swellData = sampleSwell(worldPos, uniforms.directionIndex);

  // Channel indices: R=longEnergy, G=longDir, B=shortEnergy, A=shortDir
  var energy: f32;
  if (isLongSwell) {
    energy = swellData.r;
  } else {
    energy = swellData.b;
  }

  // Interpolate from blocked (red) to exposed (green)
  let color = mix(BLOCKED_COLOR, EXPOSED_COLOR, energy);

  return vec4<f32>(color, CELL_ALPHA);
}

fn renderFetchMode(worldPos: vec2<f32>) -> vec4<f32> {
  let fetchDist = sampleFetch(worldPos, uniforms.directionIndex);

  // Log-scale interpolation (10 ft to 50000 ft)
  let minFetch = 10.0;
  let maxFetch = 50000.0;
  let t = clamp((log(max(fetchDist, minFetch)) - log(minFetch)) / (log(maxFetch) - log(minFetch)), 0.0, 1.0);

  let color = mix(SHORT_FETCH_COLOR, LONG_FETCH_COLOR, t);

  return vec4<f32>(color, CELL_ALPHA);
}

@fragment
fn fs_main(@location(0) clipPos: vec2<f32>) -> @location(0) vec4<f32> {
  // Convert clip space (-1 to 1) to normalized screen space (0 to 1)
  let screenUV = clipPos * 0.5 + 0.5;

  // Convert to world position using viewport bounds
  let worldX = uniforms.viewportBounds.x + screenUV.x * uniforms.viewportBounds.z;
  let worldY = uniforms.viewportBounds.y + (1.0 - screenUV.y) * uniforms.viewportBounds.w;
  let worldPos = vec2<f32>(worldX, worldY);

  // Base dim overlay
  var result = vec4<f32>(0.0, 0.0, 0.0, DIM_ALPHA);

  // Mode-specific rendering
  var modeColor: vec4<f32>;

  switch uniforms.mode {
    case 1: {
      // Depth grid
      modeColor = renderDepthMode(worldPos);
    }
    case 2: {
      // Long swell
      modeColor = renderSwellMode(worldPos, true);
    }
    case 3: {
      // Short chop
      modeColor = renderSwellMode(worldPos, false);
    }
    case 4: {
      // Fetch distance
      modeColor = renderFetchMode(worldPos);
    }
    default: {
      // No mode active, just dim overlay
      return result;
    }
  }

  // Blend mode color over dim overlay
  // Using standard alpha blending: result = src * srcAlpha + dst * (1 - srcAlpha)
  let srcAlpha = modeColor.a;
  result = vec4<f32>(
    modeColor.rgb * srcAlpha + result.rgb * (1.0 - srcAlpha),
    srcAlpha + result.a * (1.0 - srcAlpha)
  );

  return result;
}
`;

  protected getBlendState(): GPUBlendState {
    return {
      color: {
        srcFactor: "src-alpha",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
      alpha: {
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
    };
  }
}
