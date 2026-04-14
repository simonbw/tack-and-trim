/**
 * Water Filter Fullscreen Shader
 *
 * Runs after terrain composite + depth/color copies. Reads the frozen scene
 * color and depth and applies a fully physically-based water model:
 *
 *   T           = exp(-(ABSORPTION + SCATTERING) * submersion)   // vec3
 *   absorbed    = sceneColor * T
 *   inscatter   = skyColor * (SCATTERING / EXTINCTION) * (1 - exp(-EXTINCTION * d))
 *   transmitted = absorbed + inscatter
 *   output      = (1 - F) * transmitted + F * sky + sunColor * specular + foam
 *
 * No hand-tuned color ramps. The water's apparent color falls out of the
 * absorption + scattering spectra applied to the actual scene and sky.
 */

import {
  FullscreenShader,
  type FullscreenShaderConfig,
} from "../../core/graphics/webgpu/FullscreenShader";
import type { ShaderModule } from "../../core/graphics/webgpu/ShaderModule";
import {
  DEPTH_Z_MAX,
  DEPTH_Z_MIN,
} from "../../core/graphics/webgpu/WebGPURenderer";
import { fn_waterSurfaceLight } from "../world/shaders/lighting.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_fractalNoise3D, fn_simplex3D } from "../world/shaders/noise.wgsl";

const waterFilterParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Params {
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
  hasTerrainData: i32,
}
`,
  bindings: {
    params: { type: "uniform", wgslType: "Params" },
    sceneColorTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
    sceneDepthTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "depth",
    },
    waterHeightTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "unfilterable-float",
    },
    heightSampler: { type: "sampler", samplerType: "non-filtering" },
  },
  code: "",
};

const waterFilterVertexModule: ShaderModule = {
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

const waterFilterFragmentModule: ShaderModule = {
  dependencies: [
    waterFilterVertexModule,
    waterFilterParamsModule,
    fn_hash21,
    fn_simplex3D,
    fn_fractalNoise3D,
    fn_waterSurfaceLight,
  ],
  code: /*wgsl*/ `
// ============================================================================
// Physical water parameters
// ============================================================================

// Wavelength-dependent absorption coefficient (per foot), one per RGB channel.
// Red absorbs fastest, blue penetrates deepest — this is why deep water
// looks blue-green. Real ocean water measurements (Jerlov Type II-III coastal):
//   half-depth = ln(2) / coeff
//   red  ≈ 1.4ft, green ≈ 5.8ft, blue ≈ 11.6ft
const ABSORPTION: vec3<f32> = vec3<f32>(0.50, 0.12, 0.06);

// Wavelength-dependent scattering coefficient (per foot). Describes how much
// light is scattered out of a direct beam per foot of water travelled. In
// clean tropical water scattering is nearly wavelength-independent (Rayleigh
// at small particles, Mie at larger); in coastal water it biases slightly
// blue-green because of dissolved organic matter and plankton.
// Starting values chosen so the saturation of inscatter matches real ocean.
const SCATTERING: vec3<f32> = vec3<f32>(0.04, 0.08, 0.10);

// Total extinction: light removed from the direct path per foot of travel.
const EXTINCTION: vec3<f32> = ABSORPTION + SCATTERING;

const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};

fn mapZToDepth(z: f32) -> f32 {
  return (z - Z_MIN) / (Z_MAX - Z_MIN);
}

fn depthToZ(d: f32) -> f32 {
  return d * (Z_MAX - Z_MIN) + Z_MIN;
}

fn clipToWorld(clipPos: vec2<f32>) -> vec2<f32> {
  let m = mat3x3<f32>(
    params.cameraMatrix0.xyz,
    params.cameraMatrix1.xyz,
    params.cameraMatrix2.xyz
  );
  let world = m * vec3<f32>(clipPos, 1.0);
  return world.xy;
}

fn worldToHeightUV(worldPos: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    (worldPos.x - params.viewportLeft) / params.viewportWidth,
    (worldPos.y - params.viewportTop) / params.viewportHeight
  );
}

fn sampleWaterData(worldPos: vec2<f32>) -> vec2<f32> {
  let uv = worldToHeightUV(worldPos);
  let w = i32(params.screenWidth);
  let h = i32(params.screenHeight);
  let tx = clamp(i32(uv.x * params.screenWidth), 0, w - 1);
  let ty = clamp(i32(uv.y * params.screenHeight), 0, h - 1);
  return textureLoad(waterHeightTexture, vec2<i32>(tx, ty), 0).rg;
}

fn sampleWaterHeight(worldPos: vec2<f32>) -> f32 {
  return sampleWaterData(worldPos).x;
}

fn computeWaterNormal(worldPos: vec2<f32>) -> vec3<f32> {
  let eps = params.viewportWidth / params.screenWidth * 2.0;

  let hL = sampleWaterHeight(worldPos + vec2<f32>(-eps, 0.0));
  let hR = sampleWaterHeight(worldPos + vec2<f32>(eps, 0.0));
  let hD = sampleWaterHeight(worldPos + vec2<f32>(0.0, -eps));
  let hU = sampleWaterHeight(worldPos + vec2<f32>(0.0, eps));

  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);

  return normalize(vec3<f32>(-dx, -dy, 1.0));
}

// Physically motivated inscatter: the amount of sky light scattered toward
// the viewer from a water column of thickness d.
//
// Derivation (for a uniformly-lit column and simple single-scattering):
//   dL/dz = SCATTERING * L_sky - EXTINCTION * L   (radiative transfer)
//   L(d)  = (SCATTERING / EXTINCTION) * L_sky * (1 - exp(-EXTINCTION * d))
//
// As d → ∞ this saturates at (SCATTERING / EXTINCTION) * L_sky — the
// characteristic water color. Shallow water is nearly clear; deep water
// converges to the albedo color tinted by the sky.
fn waterInscatter(skyColor: vec3<f32>, d: f32) -> vec3<f32> {
  let albedo = SCATTERING / EXTINCTION;
  let columnFraction = vec3<f32>(1.0) - exp(-EXTINCTION * d);
  return skyColor * albedo * columnFraction;
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_main(@builtin(position) fragPos: vec4<f32>, @location(0) clipPosition: vec2<f32>) -> FragmentOutput {
  let worldPos = clipToWorld(clipPosition);
  let pixelCoord = vec2<i32>(fragPos.xy);

  // Water surface data at this pixel
  let waterData = sampleWaterData(worldPos);
  let waterHeight = waterData.x;
  let turbulence = waterData.y;

  // Scene info from the frozen copies. Z_MIN is deep enough (-100ft) that the
  // depth buffer can represent every terrain/object z we care to distinguish
  // — anything clamped to Z_MIN is beyond the underwater visibility horizon
  // and will render as pure water regardless.
  let sceneColor = textureLoad(sceneColorTexture, pixelCoord, 0).rgb;
  let sceneDepthNDC = textureLoad(sceneDepthTexture, pixelCoord, 0);
  let sceneZ = depthToZ(sceneDepthNDC);
  // Depth cleared to 0 (= Z_MIN). Anything drawn lifts it above Z_MIN.
  let scenePresent = sceneZ > (Z_MIN + 0.1);

  let submersion = waterHeight - sceneZ;

  let foamColor = vec3<f32>(0.95, 0.98, 1.0);

  // Foam from turbulence (wave breaking + wake)
  var turbulenceFoam = 0.0;
  if (turbulence > 0.0) {
    let foamNoise = fractalNoise3D(vec3<f32>(
      worldPos.x * 0.5,
      worldPos.y * 0.5,
      params.time * 0.4
    )) * 0.5 + 0.5;
    let foamCoverage = (1.0 - exp(-turbulence * 1.0)) * 0.7;
    let foamThreshold = 1.0 - foamCoverage;
    turbulenceFoam = smoothstep(foamThreshold - 0.15, foamThreshold, foamNoise) * foamCoverage;
  }

  var finalColor: vec3<f32>;
  var surfaceZ: f32;

  if (scenePresent && submersion <= 0.0) {
    // Scene pixel is above the water surface — pass through untouched.
    finalColor = sceneColor;
    surfaceZ = sceneZ;
  } else {
    // Scene pixel is underwater, OR no scene at all (open ocean: treat as
    // infinite depth so the column fully saturates to the water albedo).
    let effectiveSubmersion = select(submersion, 1000.0, !scenePresent);

    // Extinction transmittance per channel: light surviving a round trip
    // from the scene point up to the surface.
    let T = exp(-EXTINCTION * effectiveSubmersion);

    // Absorbed scene: scene color multiplied by the wavelength-dependent
    // transmittance. Red dies fastest, blue survives — color shifts cyan.
    let absorbed = select(vec3<f32>(0.0), sceneColor * T, scenePresent);

    // Inscatter: sky light scattered by the water column toward the viewer.
    // Saturates at skyColor * (SCATTERING / EXTINCTION) in deep water.
    let skyColor = getSkyColor(params.time);
    let inscatter = waterInscatter(skyColor, effectiveSubmersion);

    // Light arriving at the underside of the water surface
    let transmitted = absorbed + inscatter;

    // Surface: Fresnel-weighted mix of transmitted and sky, plus sun specular
    let waterNormal = computeWaterNormal(worldPos);
    let viewDir = vec3<f32>(0.0, 0.0, 1.0);
    finalColor = waterSurfaceLight(waterNormal, viewDir, transmitted, params.time);

    // Shoreline / object-waterline foam: where submersion is tiny.
    // Works uniformly for terrain shores and hull waterlines.
    if (scenePresent) {
      let shorelineThreshold = 0.2;
      if (submersion < shorelineThreshold) {
        let foamIntensity = (1.0 - (submersion / shorelineThreshold)) * 0.7;
        finalColor = mix(finalColor, foamColor, foamIntensity);
      }
    }

    // Turbulence foam layered on top of the water
    finalColor = mix(finalColor, foamColor, turbulenceFoam);

    // Write water surface z to depth so post-water particles sort correctly.
    surfaceZ = max(waterHeight, sceneZ);
  }

  var out: FragmentOutput;
  out.color = vec4<f32>(finalColor, 1.0);
  out.depth = mapZToDepth(surfaceZ);
  return out;
}
`,
};

const waterFilterShaderConfig: FullscreenShaderConfig = {
  modules: [waterFilterFragmentModule],
  label: "WaterFilterShader",
  // Opaque: no hardware blend. The shader is the compositor — it reads the
  // already-rendered scene from colorCopyTexture and writes the final pixel.
  depthStencilState: {
    format: "depth24plus",
    depthCompare: "always",
    depthWriteEnabled: true,
  },
};

export function createWaterFilterShader(): FullscreenShader {
  return new FullscreenShader(waterFilterShaderConfig);
}
