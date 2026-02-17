/**
 * Surface Composite Fullscreen Shader
 *
 * Final pass of the multi-pass surface rendering pipeline.
 * Reads height textures, computes normals via finite differences,
 * and renders water/terrain with full lighting.
 *
 * Inputs:
 * - Water height texture (rg32float: R=height, G=turbulence)
 * - Terrain tile atlas (r32float)
 *
 * Output:
 * - Final surface color with lighting
 */

import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import { fn_renderWaterLighting } from "../world/shaders/lighting.wgsl";
import { fn_renderSand } from "../world/shaders/sand-rendering.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_fractalNoise3D, fn_simplex3D } from "../world/shaders/noise.wgsl";

// Shallow water threshold for rendering
const SHALLOW_WATER_THRESHOLD = 1.5;

/**
 * Params module with uniforms and bindings for surface composite.
 */
const surfaceCompositeParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
// Surface composite parameters
struct Params {
  // Camera matrix for screen-to-world transform (3x3, stored as 3 vec4s for alignment)
  cameraMatrix0: vec4<f32>,
  cameraMatrix1: vec4<f32>,
  cameraMatrix2: vec4<f32>,

  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  time: f32,
  tideHeight: f32,
  shallowThreshold: f32,
  hasTerrainData: i32,

  // Terrain tile atlas parameters
  atlasTileSize: u32,
  atlasTilesX: u32,
  atlasTilesY: u32,
  atlasWorldUnitsPerTile: f32,

  // Camera viewport (non-expanded) for correct clip-to-world mapping
  cameraLeft: f32,
  cameraTop: f32,
  cameraWidth: f32,
  cameraHeight: f32,
}

const SHALLOW_WATER_THRESHOLD: f32 = ${SHALLOW_WATER_THRESHOLD};
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    waterHeightTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
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
    heightSampler: { type: "sampler", samplerType: "non-filtering" },
  },
  code: "",
};

/**
 * Vertex shader for fullscreen quad.
 */
const surfaceCompositeVertexModule: ShaderModule = {
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

/**
 * Fragment shader code for surface composite.
 */
const surfaceCompositeFragmentModule: ShaderModule = {
  dependencies: [
    surfaceCompositeVertexModule,
    surfaceCompositeParamsModule,
    fn_hash21,
    fn_simplex3D,
    fn_fractalNoise3D,
    fn_renderWaterLighting,
    fn_renderSand,
  ],
  code: /*wgsl*/ `
// Convert clip position to world position using the camera viewport.
// Uses the non-expanded camera viewport so that screen pixels map to the
// same world positions as the camera matrix used by all other rendering
// (game objects, debug overlays, etc.).
fn clipToWorld(clipPos: vec2<f32>) -> vec2<f32> {
  // Convert clip space (-1,1) to UV space (0,1)
  // Flip Y to match screen coordinates (clip Y=1 is top, screen Y=0 is top)
  let uvX = clipPos.x * 0.5 + 0.5;
  let uvY = -clipPos.y * 0.5 + 0.5;

  // Map UV to world coordinates using the camera viewport (not expanded)
  return vec2<f32>(
    params.cameraLeft + uvX * params.cameraWidth,
    params.cameraTop + uvY * params.cameraHeight
  );
}

// Convert world position to UV for height texture sampling
fn worldToHeightUV(worldPos: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    (worldPos.x - params.viewportLeft) / params.viewportWidth,
    (worldPos.y - params.viewportTop) / params.viewportHeight
  );
}

// Sample water height and turbulence at world position
fn sampleWaterData(worldPos: vec2<f32>) -> vec2<f32> {
  let uv = worldToHeightUV(worldPos);
  let texCoord = vec2<i32>(
    i32(uv.x * params.screenWidth),
    i32(uv.y * params.screenHeight)
  );
  return textureLoad(waterHeightTexture, texCoord, 0).rg;
}

// Sample height texture at world position
fn sampleWaterHeight(worldPos: vec2<f32>) -> f32 {
  return sampleWaterData(worldPos).r;
}

// Sample wetness texture at world position
fn sampleWetness(worldPos: vec2<f32>) -> f32 {
  let uv = worldToHeightUV(worldPos);
  let texCoord = vec2<i32>(
    i32(uv.x * params.screenWidth),
    i32(uv.y * params.screenHeight)
  );
  return textureLoad(wetnessTexture, texCoord, 0).r;
}

// Manual bilinear interpolation for terrain height sampling
// Since r32float is unfilterable, we implement bilinear filtering manually
fn sampleTerrainHeightBilinear(worldPos: vec2<f32>) -> f32 {
  // Convert world position to tile coordinates
  let worldUnitsPerTile = params.atlasWorldUnitsPerTile;
  let tileSize = params.atlasTileSize;

  // Calculate which tile this world position is in
  let tileX = floor(worldPos.x / worldUnitsPerTile);
  let tileY = floor(worldPos.y / worldUnitsPerTile);

  // Calculate position within the tile (0-1), in pixel coordinates
  let localX = (worldPos.x - tileX * worldUnitsPerTile) / worldUnitsPerTile * f32(tileSize);
  let localY = (worldPos.y - tileY * worldUnitsPerTile) / worldUnitsPerTile * f32(tileSize);

  // Calculate atlas slot from tile coordinates using modulo for wrapping
  let slotX = i32(tileX) % i32(params.atlasTilesX);
  let slotY = i32(tileY) % i32(params.atlasTilesY);

  // Handle negative coordinates (WGSL % can return negative values)
  let wrappedSlotX = u32(select(slotX, slotX + i32(params.atlasTilesX), slotX < 0));
  let wrappedSlotY = u32(select(slotY, slotY + i32(params.atlasTilesY), slotY < 0));

  // Get the four surrounding pixels for bilinear interpolation
  let px = floor(localX - 0.5); // Pixel centers are at 0.5, 1.5, 2.5, etc.
  let py = floor(localY - 0.5);
  let fx = localX - 0.5 - px; // Fractional part
  let fy = localY - 0.5 - py;

  // Clamp to valid pixel range within tile
  let px0 = u32(clamp(px, 0.0, f32(tileSize - 1)));
  let py0 = u32(clamp(py, 0.0, f32(tileSize - 1)));
  let px1 = u32(clamp(px + 1.0, 0.0, f32(tileSize - 1)));
  let py1 = u32(clamp(py + 1.0, 0.0, f32(tileSize - 1)));

  // Calculate atlas pixel coordinates
  let baseX = wrappedSlotX * tileSize;
  let baseY = wrappedSlotY * tileSize;

  // Sample the four corners
  let h00 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px0), i32(baseY + py0)), 0).r;
  let h10 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px1), i32(baseY + py0)), 0).r;
  let h01 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px0), i32(baseY + py1)), 0).r;
  let h11 = textureLoad(terrainTileAtlas, vec2<i32>(i32(baseX + px1), i32(baseY + py1)), 0).r;

  // Bilinear interpolation
  let h0 = mix(h00, h10, fx);
  let h1 = mix(h01, h11, fx);
  return mix(h0, h1, fy);
}

// Sample terrain height from tile atlas using bilinear filtering
fn sampleTerrainHeight(worldPos: vec2<f32>) -> f32 {
  return sampleTerrainHeightBilinear(worldPos);
}

// Compute normal from height texture via finite differences
fn computeWaterNormal(worldPos: vec2<f32>) -> vec3<f32> {
  let eps = params.viewportWidth / params.screenWidth * 2.0; // 2 pixel spacing

  let hL = sampleWaterHeight(worldPos + vec2<f32>(-eps, 0.0));
  let hR = sampleWaterHeight(worldPos + vec2<f32>(eps, 0.0));
  let hD = sampleWaterHeight(worldPos + vec2<f32>(0.0, -eps));
  let hU = sampleWaterHeight(worldPos + vec2<f32>(0.0, eps));

  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);

  return normalize(vec3<f32>(-dx, -dy, 1.0));
}

fn computeTerrainNormal(worldPos: vec2<f32>) -> vec3<f32> {
  let eps = params.viewportWidth / params.screenWidth * 2.0;

  let hL = sampleTerrainHeight(worldPos + vec2<f32>(-eps, 0.0));
  let hR = sampleTerrainHeight(worldPos + vec2<f32>(eps, 0.0));
  let hD = sampleTerrainHeight(worldPos + vec2<f32>(0.0, -eps));
  let hU = sampleTerrainHeight(worldPos + vec2<f32>(0.0, eps));

  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);

  return normalize(vec3<f32>(-dx, -dy, 1.0));
}

// Get view direction for 2D top-down view (looking down at water)
fn getViewDir() -> vec3<f32> {
  return vec3<f32>(0.0, 0.0, 1.0);
}

// Subtle caustic-like texture to give the water visual detail for motion perception.
// Two layers of simplex noise at different scales, slowly animated, blended together.
fn waterCausticPattern(worldPos: vec2<f32>) -> f32 {
  let t = params.time * 0.15;
  // Two octaves at different scales and speeds for organic feel
  let n1 = simplex3D(vec3<f32>(worldPos * 0.8, t));
  let n2 = simplex3D(vec3<f32>(worldPos * 1.6 + 5.0, t * 1.7));
  // Combine and shape: abs gives caustic-like bright lines
  let combined = abs(n1 + n2 * 0.5) * 0.667;
  // Sharpen to get bright caustic lines on a darker base
  return smoothstep(0.3, 0.7, combined);
}

// Compute water color using water lighting
fn computeWaterColorAtPoint(normal: vec3<f32>, waterHeight: f32, waterDepth: f32, worldPos: vec2<f32>) -> vec3<f32> {
  let viewDir = getViewDir();
  // Use water height normalized to 0-1 range (approximate based on typical wave heights)
  let rawHeight = saturate((waterHeight + 2.0) / 4.0);
  var color = renderWaterLighting(normal, viewDir, rawHeight, waterDepth, params.time);

  // Apply subtle caustic texture - fades in with depth so shallow water stays clean
  let caustic = waterCausticPattern(worldPos);
  let causticStrength = smoothstep(0.5, 3.0, waterDepth) * 0.03;
  color = color + caustic * causticStrength;

  return color;
}

@fragment
fn fs_main(@location(0) clipPosition: vec2<f32>) -> @location(0) vec4<f32> {
  let worldPos = clipToWorld(clipPosition);

  // Sample heights, turbulence, and wetness from textures
  let waterData = sampleWaterData(worldPos);
  let waterHeight = waterData.x;
  let turbulence = waterData.y;
  let terrainHeight = sampleTerrainHeight(worldPos);
  let wetness = sampleWetness(worldPos);

  // Calculate water depth
  let waterDepth = waterHeight - terrainHeight;

  // Compute normals from height textures
  let waterNormal = computeWaterNormal(worldPos);
  let terrainNormal = computeTerrainNormal(worldPos);

  // Render based on depth
  let foamColor = vec3<f32>(0.95, 0.98, 1.0);

  // Breaking foam: fractal noise for natural, streaky foam in breaking zones
  var turbulenceFoam = 0.0;
  if (turbulence > 0.0) {
    // Fractal noise for multi-scale foam texture
    let foamNoise = fractalNoise3D(vec3<f32>(
      worldPos.x * 0.5,
      worldPos.y * 0.5,
      params.time * 0.4
    ));

    // Threshold-based foam: more breaking = lower threshold = more foam coverage
    let foamThreshold = 1.0 - turbulence * 0.8;
    let foamAmount = smoothstep(foamThreshold - 0.15, foamThreshold, foamNoise);

    turbulenceFoam = foamAmount * turbulence;
  }

  if (params.hasTerrainData == 0) {
    // No terrain data - render as deep water
    var color = computeWaterColorAtPoint(waterNormal, waterHeight, 100.0, worldPos);
    color = mix(color, foamColor, turbulenceFoam);
    return vec4<f32>(color, 1.0);
  }

  if (waterDepth < 0.0) {
    // Above water - render as sand/terrain with tracked wetness
    let color = renderSand(terrainHeight, terrainNormal, worldPos, wetness, params.time);
    return vec4<f32>(color, 1.0);
  } else if (waterDepth < params.shallowThreshold) {
    // Shallow water - blend between sand and water with sharp transition
    // Use power curve for sharper edge while maintaining some gradual depth visibility
    let normalizedDepth = waterDepth / params.shallowThreshold;
    let blendFactor = pow(normalizedDepth, 0.4); // Sharp at edge, gradual deeper

    // For underwater sand, use max of tracked wetness and water depth
    let underwaterWetness = max(wetness, waterDepth);
    let sandColor = renderSand(terrainHeight, terrainNormal, worldPos, underwaterWetness, params.time);
    let waterColor = computeWaterColorAtPoint(waterNormal, waterHeight, waterDepth, worldPos);
    var finalColor = mix(sandColor, waterColor, blendFactor);

    // Add foam at the water's edge
    let foamThreshold = 0.2; // Foam appears in first 0.2 units of water depth
    if (waterDepth < foamThreshold) {
      // Foam intensity: strong at edge (depth=0), fades out at foamThreshold
      let foamIntensity = (1.0 - (waterDepth / foamThreshold)) * 0.7;
      finalColor = mix(finalColor, foamColor, foamIntensity);
    }

    // Breaking wave foam on crests
    finalColor = mix(finalColor, foamColor, turbulenceFoam);

    return vec4<f32>(finalColor, 1.0);
  } else {
    // Deep water
    var color = computeWaterColorAtPoint(waterNormal, waterHeight, waterDepth, worldPos);
    color = mix(color, foamColor, turbulenceFoam);
    return vec4<f32>(color, 1.0);
  }
}
`,
};

const surfaceCompositeShaderConfig: FullscreenShaderConfig = {
  modules: [surfaceCompositeFragmentModule],
  label: "SurfaceCompositeShader",
};

export function createSurfaceCompositeShader(): FullscreenShader {
  return new FullscreenShader(surfaceCompositeShaderConfig);
}
