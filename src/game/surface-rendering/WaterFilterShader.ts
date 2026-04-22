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
import { SCENE_LIGHTING_WGSL_FIELDS } from "../time/SceneLighting";
import { fn_waterSurfaceLight } from "../world/shaders/lighting.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_fractalNoise3D, fn_simplex3D } from "../world/shaders/noise.wgsl";
import { SURFACE_TEXTURE_MARGIN } from "./SurfaceConstants";

const waterFilterParamsModule: ShaderModule = {
  preamble: /*wgsl*/ `
struct Params {
  // clip → world for the actual screen
  cameraMatrix: mat3x3<f32>,
  // world → clip for the screen-space water height texture
  worldToTexClip: mat3x3<f32>,

  screenWidth: f32,
  screenHeight: f32,
  pixelRatio: f32,
  time: f32,
  tideHeight: f32,
  hasTerrainData: i32,

  // Bio-optical water chemistry (per level/region)
  chlorophyll: f32,
  cdom: f32,
  sediment: f32,

  // Scene lighting — populated from TimeOfDay on the CPU each frame.
  ${SCENE_LIGHTING_WGSL_FIELDS}
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
      sampleType: "float",
    },
    // Per-boat air gap texture. Encodes bilge surface Z (R), deck cap Z (G),
    // and bilge slosh turbulence (B) at pixels inside any hull footprint;
    // sentinel low outside. Used here — not in the water height compute —
    // so that the water height texture stays a continuous ocean surface
    // and its finite-differenced normal has no cliffs at hull edges.
    boatAirTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
    heightSampler: { type: "sampler", samplerType: "filtering" },
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
// Bio-optical water model
// ============================================================================
//
// Water optics decompose into contributions from four constituents, each
// with a fixed spectral signature (vec3 per RGB channel, per foot). The
// runtime mixes them using scalar concentrations supplied via uniforms:
//
//   a(λ) = a_water(λ) + a_phyto(λ)*C_chl + a_cdom(λ)*C_cdom + a_part(λ)*C_sed
//   b(λ) = b_water(λ) + b_phyto(λ)*C_chl +                  b_part(λ)*C_sed
//
// (CDOM is dissolved, doesn't scatter, only absorbs.)
//
// Constants below are physically motivated rough-fits to published IOCCG
// bio-optical data, scaled to per-foot units. They're in the right ballpark
// but tuned by eye for good-looking water at default concentrations.

// --- Pure water (Pope & Fry 1997, scaled to per-foot) ---
// Red absorbs fast; blue barely at all. Nearly zero scattering.
const A_WATER_PURE: vec3<f32> = vec3<f32>(0.20, 0.018, 0.004);
const B_WATER_PURE: vec3<f32> = vec3<f32>(0.0002, 0.0004, 0.0009);

// --- Phytoplankton (per mg/m³ chlorophyll-a) ---
// Absorbs blue (440nm) and red (675nm); transmits green — algae look green.
// Scattering is mild and slightly blue-biased.
const A_PHYTO: vec3<f32> = vec3<f32>(0.040, 0.010, 0.030);
const B_PHYTO: vec3<f32> = vec3<f32>(0.003, 0.004, 0.005);

// --- CDOM / yellow substance (per normalized concentration) ---
// Dissolved organic matter — exponential decay toward red. Strong blue
// absorber, negligible at red. Gives tea-stained coastal water its
// yellow-brown cast. Does not scatter.
const A_CDOM: vec3<f32> = vec3<f32>(0.001, 0.020, 0.100);

// --- Suspended particles (per normalized concentration) ---
// Sand, silt, resuspended sediment. Scatters strongly and nearly flat
// across wavelengths; absorption is mild.
const A_PARTICLES: vec3<f32> = vec3<f32>(0.015, 0.015, 0.015);
const B_PARTICLES: vec3<f32> = vec3<f32>(0.040, 0.045, 0.050);

struct WaterOptics {
  absorption: vec3<f32>,
  scattering: vec3<f32>,
  extinction: vec3<f32>,
};

// Compute per-pixel water optics from three constituent concentrations.
fn computeWaterOptics(chl: f32, cdom: f32, sediment: f32) -> WaterOptics {
  let a = A_WATER_PURE
        + A_PHYTO * chl
        + A_CDOM * cdom
        + A_PARTICLES * sediment;
  let b = B_WATER_PURE
        + B_PHYTO * chl
        + B_PARTICLES * sediment;
  var optics: WaterOptics;
  optics.absorption = a;
  optics.scattering = b;
  optics.extinction = a + b;
  return optics;
}

const Z_MIN: f32 = ${DEPTH_Z_MIN};
const Z_MAX: f32 = ${DEPTH_Z_MAX};

// Integer offset from screen pixel to surface-texture texel (texels are
// 1:1 with screen pixels, shifted by this margin). See SurfaceConstants.ts.
const SURFACE_TEXTURE_MARGIN: i32 = ${SURFACE_TEXTURE_MARGIN};

fn mapZToDepth(z: f32) -> f32 {
  return (z - Z_MIN) / (Z_MAX - Z_MIN);
}

fn depthToZ(d: f32) -> f32 {
  return d * (Z_MAX - Z_MIN) + Z_MIN;
}

fn clipToWorld(clipPos: vec2<f32>) -> vec2<f32> {
  let world = params.cameraMatrix * vec3<f32>(clipPos, 1.0);
  return world.xy;
}

// World → surface-texture UV. The surface texture is (screen + 2*margin)
// on each axis with a pixel-integer margin, so worldToTexClip maps the
// texture's clip[-1,1] over screen pixel range [-m, W+m]. Used by the
// finite-diff normal sample since eps is non-integer in texel space.
fn worldToHeightUV(worldPos: vec2<f32>) -> vec2<f32> {
  let clip = (params.worldToTexClip * vec3<f32>(worldPos, 1.0)).xy;
  return vec2<f32>((clip.x + 1.0) * 0.5, (1.0 - clip.y) * 0.5);
}

fn sampleWaterData(worldPos: vec2<f32>) -> vec2<f32> {
  let uv = worldToHeightUV(worldPos);
  return textureSampleLevel(waterHeightTexture, heightSampler, uv, 0.0).rg;
}

fn sampleWaterHeight(worldPos: vec2<f32>) -> f32 {
  return sampleWaterData(worldPos).x;
}

fn computeWaterNormal(worldPos: vec2<f32>) -> vec3<f32> {
  // World-space eps ≈ 2 screen pixels (see TerrainCompositeShader).
  let eps = length(params.cameraMatrix[0].xy) * 4.0 / params.screenWidth;

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
// Derivation (uniformly-lit column, simple single-scattering):
//   dL/dz = scattering * L_sky - extinction * L   (radiative transfer)
//   L(d)  = (scattering / extinction) * L_sky * (1 - exp(-extinction * d))
//
// As d → ∞ this saturates at (scattering / extinction) * L_sky — the
// characteristic water color. Shallow water is nearly clear; deep water
// converges to the single-scattering albedo tinted by the sky.
fn waterInscatter(
  skyColor: vec3<f32>,
  scattering: vec3<f32>,
  extinction: vec3<f32>,
  d: f32,
) -> vec3<f32> {
  let albedo = scattering / extinction;
  let columnFraction = vec3<f32>(1.0) - exp(-extinction * d);
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

  // Ocean surface data at this pixel — point-sampled at the exact texel
  // so the submersion test can't pick up a linearly-interpolated value
  // across a discontinuity. Linear sampling is still used below for
  // finite-diff normals; that's safe now because the water height texture
  // is a continuous ocean surface (no substitution cliffs at hull edges).
  //
  // fragPos.xy is in physical framebuffer pixels; the surface textures are
  // sized at logical + margin, so divide by pixelRatio before offsetting.
  let logicalCoord = vec2<i32>(fragPos.xy / params.pixelRatio);
  let waterTexel = logicalCoord + vec2<i32>(SURFACE_TEXTURE_MARGIN, SURFACE_TEXTURE_MARGIN);
  let waterData = textureLoad(waterHeightTexture, waterTexel, 0).rg;
  let oceanHeight = waterData.x;
  var turbulence = waterData.y;

  // Boat air substitution. BoatAirShader publishes per-pixel air gaps
  // (bilge surface Z in R, deck cap Z in G, bilge turbulence in B) at
  // pixels inside any hull footprint. If the ocean surface would lie
  // inside an air column at this pixel, the effective water surface here
  // is the bilge level — substitute it into waterHeight. Outside any
  // hull, R and G are sentinel low so the range test fails and we fall
  // through to the ocean value.
  let airData = textureLoad(boatAirTexture, waterTexel, 0);
  let airMin = airData.r;
  let airMax = airData.g;
  let bilgeTurb = airData.b;
  var waterHeight = oceanHeight;
  if (airMax > airMin && oceanHeight >= airMin && oceanHeight <= airMax) {
    waterHeight = airMin;
    turbulence = bilgeTurb;
  }

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

  // Foam lit by ambient (sky + sun) so it doesn't glow at night.
  let foamColor = vec3<f32>(0.95, 0.98, 1.0) * (params.skyColor * 0.5 + params.sunColor);

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

    // -----------------------------------------------------------------
    // Per-pixel bio-optical modulation
    // -----------------------------------------------------------------
    // Start from the level/region base concentrations and modulate by
    // local conditions:
    //   - shallowFactor: near-bottom water has more resuspended sediment,
    //     more plankton in the photic zone, more shore-runoff CDOM.
    //     Decays exponentially with water column depth.
    //   - turbulenceFactor: breaking waves and wakes stir the bottom,
    //     boosting sediment locally. Turbulence comes from the G channel
    //     of waterHeightTexture (wake/breakers).
    let depthForMod = select(1000.0, max(submersion, 0.0), scenePresent);
    let shallowFactor = 1.0 + 2.0 * exp(-depthForMod * 0.15);
    let turbulenceFactor = 1.0 + 3.0 * turbulence;

    let localChl = params.chlorophyll * shallowFactor;
    let localCdom = params.cdom * shallowFactor;
    let localSediment = params.sediment * shallowFactor * turbulenceFactor;

    let optics = computeWaterOptics(localChl, localCdom, localSediment);
    let extinction = optics.extinction;
    let scattering = optics.scattering;

    // Extinction transmittance per channel: light surviving a direct path
    // from the scene point up to the surface.
    let T = exp(-extinction * effectiveSubmersion);

    // Absorbed scene: scene color multiplied by the wavelength-dependent
    // transmittance. Red dies fastest, blue survives — color shifts cyan.
    let absorbed = select(vec3<f32>(0.0), sceneColor * T, scenePresent);

    // Inscatter: sky light scattered by the water column toward the viewer.
    let inscatter = waterInscatter(params.skyColor, scattering, extinction, effectiveSubmersion);

    // Light arriving at the underside of the water surface
    let transmitted = absorbed + inscatter;

    // Surface: Fresnel-weighted mix of transmitted and sky, plus sun specular
    let waterNormal = computeWaterNormal(worldPos);
    let viewDir = vec3<f32>(0.0, 0.0, 1.0);
    finalColor = waterSurfaceLight(
      waterNormal,
      viewDir,
      transmitted,
      params.sunDirection,
      params.sunColor,
      params.skyColor,
    );

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
