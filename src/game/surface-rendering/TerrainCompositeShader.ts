/**
 * Terrain Composite Fullscreen Shader
 *
 * Renders above-water terrain (sand, rock, snow) into the scene color target.
 * Runs after the boat layer but before the water filter pass. Pixels where
 * waterDepth >= 0 are discarded — the water filter handles those.
 *
 * Depth test is greater-equal so boat pixels (higher z) already written to
 * the depth buffer correctly block terrain draws.
 */

import {
  defineUniformStruct,
  f32,
  i32,
  mat3x3,
  u32,
} from "../../core/graphics/UniformStruct";
import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import {
  DEPTH_Z_MAX,
  DEPTH_Z_MIN,
} from "../../core/graphics/webgpu/WebGPURenderer";
import {
  SCENE_LIGHTING_FIELDS,
  SCENE_LIGHTING_WGSL_FIELDS,
} from "../time/SceneLighting";
import { fn_renderTerrain } from "../world/shaders/terrain-rendering.wgsl";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import { SURFACE_TEXTURE_MARGIN } from "./SurfaceConstants";

export const TerrainCompositeUniforms = defineUniformStruct("Params", {
  // Clip → world for the actual screen (used for world-position reconstruction).
  cameraMatrix: mat3x3,

  // Screen dimensions (logical/CSS pixels)
  screenWidth: f32,
  screenHeight: f32,

  // Device pixel ratio — the fragment shader's fragPos.xy is in physical
  // framebuffer pixels, but the surface textures are sized at logical+margin
  // resolution. Divide fragPos.xy by this to get logical pixel coords.
  pixelRatio: f32,

  tideHeight: f32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,

  // Scene lighting (see SceneLighting.ts). Populated from TimeOfDay.
  ...SCENE_LIGHTING_FIELDS,
});

const terrainCompositeParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Params {
  // clip → world for the actual screen
  cameraMatrix: mat3x3<f32>,

  screenWidth: f32,
  screenHeight: f32,
  pixelRatio: f32,
  tideHeight: f32,

  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,

  // Scene lighting — populated from TimeOfDay on the CPU each frame.
  ${SCENE_LIGHTING_WGSL_FIELDS}
}
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    terrainTileAtlas: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    wetnessTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    // Screen-space dynamic lighting buffer. Same canvas-pixel grid as the
    // framebuffer, so we can textureLoad by integer fragment position.
    lightsTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
  },
  code: "",
};

const terrainCompositeVertexModule: ShaderModule = {
  code: /*wgsl*/ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.clipPosition = position;
  return output;
}
`,
};

const terrainCompositeFragmentModule: ShaderModule = {
  dependencies: [
    terrainCompositeVertexModule,
    terrainCompositeParamsModule,
    fn_simplex3D,
    fn_renderTerrain,
  ],
  code: /*wgsl*/ `
fn clipToWorld(clipPos: vec2<f32>) -> vec2<f32> {
  let world = params.cameraMatrix * vec3<f32>(clipPos, 1.0);
  return world.xy;
}

// Logical pixel (i,j) → wetness texel (i+M, j+M). The wetness texture shares
// the surface-texture layout: logical + 2*margin with pixel-aligned texels.
fn sampleWetnessAtLogical(logicalCoord: vec2<i32>) -> f32 {
  let t = logicalCoord + vec2<i32>(SURFACE_TEXTURE_MARGIN, SURFACE_TEXTURE_MARGIN);
  return textureLoad(wetnessTexture, t, 0).r;
}

// Manual bilinear sample of terrain tile atlas (r32float is unfilterable).
fn sampleTerrainHeightBilinear(worldPos: vec2<f32>) -> f32 {
  let worldUnitsPerTile = params.atlasWorldUnitsPerTile;
  let tileSize = params.atlasTileSize;

  let tileX = floor(worldPos.x / worldUnitsPerTile);
  let tileY = floor(worldPos.y / worldUnitsPerTile);

  let localX = (worldPos.x - tileX * worldUnitsPerTile) / worldUnitsPerTile * f32(tileSize);
  let localY = (worldPos.y - tileY * worldUnitsPerTile) / worldUnitsPerTile * f32(tileSize);

  let slotX = i32(tileX) % i32(params.atlasTilesX);
  let slotY = i32(tileY) % i32(params.atlasTilesY);
  let wrappedSlotX = u32(select(slotX, slotX + i32(params.atlasTilesX), slotX < 0));
  let wrappedSlotY = u32(select(slotY, slotY + i32(params.atlasTilesY), slotY < 0));

  let px = floor(localX - 0.5);
  let py = floor(localY - 0.5);
  let fx = localX - 0.5 - px;
  let fy = localY - 0.5 - py;

  let px0 = u32(clamp(px, 0.0, f32(tileSize - 1)));
  let py0 = u32(clamp(py, 0.0, f32(tileSize - 1)));
  let px1 = u32(clamp(px + 1.0, 0.0, f32(tileSize - 1)));
  let py1 = u32(clamp(py + 1.0, 0.0, f32(tileSize - 1)));

  let baseX = wrappedSlotX * tileSize;
  let baseY = wrappedSlotY * tileSize;

  let h00 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px0), i32(baseY + py0)), 0).r;
  let h10 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px1), i32(baseY + py0)), 0).r;
  let h01 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px0), i32(baseY + py1)), 0).r;
  let h11 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px1), i32(baseY + py1)), 0).r;

  let h0 = mix(h00, h10, fx);
  let h1 = mix(h01, h11, fx);
  return mix(h0, h1, fy);
}

fn sampleTerrainHeight(worldPos: vec2<f32>) -> f32 {
  return sampleTerrainHeightBilinear(worldPos);
}

fn computeTerrainNormal(worldPos: vec2<f32>) -> vec3<f32> {
  // World-space eps ≈ 2 screen pixels. cameraMatrix[0].xy is the world vector
  // for one clip-X unit; clip spans 2 units across screenWidth pixels.
  let eps = length(params.cameraMatrix[0].xy) * 4.0 / params.screenWidth;

  let hL = sampleTerrainHeight(worldPos + vec2<f32>(-eps, 0.0));
  let hR = sampleTerrainHeight(worldPos + vec2<f32>(eps, 0.0));
  let hD = sampleTerrainHeight(worldPos + vec2<f32>(0.0, -eps));
  let hU = sampleTerrainHeight(worldPos + vec2<f32>(0.0, eps));

  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);

  return normalize(vec3<f32>(-dx, -dy, 1.0));
}

const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};

// Integer offset from screen pixel to surface-texture texel. See
// SurfaceConstants.ts.
const SURFACE_TEXTURE_MARGIN: i32 = ${SURFACE_TEXTURE_MARGIN};

fn mapZToDepth(z: f32) -> f32 {
  return (z - Z_MIN) / (Z_MAX - Z_MIN);
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_main(@builtin(position) fragPos: vec4<f32>, @location(0) clipPosition: vec2<f32>) -> FragmentOutput {
  let worldPos = clipToWorld(clipPosition);
  // fragPos.xy is in physical framebuffer pixels; convert to logical pixel
  // coords to index the logical-sized wetness texture.
  let logicalCoord = vec2<i32>(fragPos.xy / params.pixelRatio);

  // Render terrain at every pixel (both above AND below water). The water
  // filter reads the color + depth and applies absorption for submerged
  // pixels; without terrain color/depth here it would treat underwater
  // pixels as infinitely deep and all depths would look the same.
  let terrainHeight = sampleTerrainHeight(worldPos);
  let terrainNormal = computeTerrainNormal(worldPos);
  let wetness = sampleWetnessAtLogical(logicalCoord);

  var finalColor = renderTerrain(
    terrainHeight,
    terrainNormal,
    worldPos,
    wetness,
    params.sunDirection,
    params.sunColor,
    params.skyColor,
  );

  // Screen-space dynamic lighting contribution. Composited as a screen
  // blend so a fully-white-at-full-intensity light drives the pixel to
  // (1,1,1) and not beyond — same saturation contract as the boat
  // shape shader.
  let lightSample = clamp(
    textureLoad(lightsTexture, vec2<i32>(fragPos.xy), 0).rgb,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  finalColor = vec3<f32>(1.0) - (vec3<f32>(1.0) - clamp(finalColor, vec3<f32>(0.0), vec3<f32>(1.0))) * (vec3<f32>(1.0) - lightSample);

  var out: FragmentOutput;
  out.color = vec4<f32>(finalColor, 1.0);
  out.depth = mapZToDepth(terrainHeight);
  return out;
}
`,
};

const terrainCompositeShaderConfig: FullscreenShaderConfig = {
  modules: [terrainCompositeFragmentModule],
  label: "TerrainCompositeShader",
  // Opaque — terrain owns every above-water pixel it writes.
  // No blendState means no color blending (default overwrite).
  depthStencilState: {
    format: "depth24plus",
    // Boat pixels that are higher in z were written first and will block
    // terrain pixels underneath them from being drawn.
    depthCompare: "greater-equal",
    depthWriteEnabled: true,
  },
};

export function createTerrainCompositeShader(): FullscreenShader {
  return new FullscreenShader(terrainCompositeShaderConfig);
}
