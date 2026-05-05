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
 *   output      = (1 - F) * transmitted + F * sky + sunColor * specular
 *
 * No hand-tuned color ramps. The water's apparent color falls out of the
 * absorption + scattering spectra applied to the actual scene and sky.
 */

import {
  defineUniformStruct,
  f32,
  i32,
  mat3x3,
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
import { fn_waterSurfaceLight } from "../world/shaders/lighting.wgsl";
import { fn_hash21 } from "../world/shaders/math.wgsl";
import { fn_simplex3D } from "../world/shaders/noise.wgsl";
import { SURFACE_TEXTURE_MARGIN } from "./SurfaceConstants";

export const WaterFilterUniforms = defineUniformStruct("Params", {
  // Clip → world for the actual screen.
  cameraMatrix: mat3x3,

  // World → clip for the screen-space water height texture.
  worldToTexClip: mat3x3,

  screenWidth: f32,
  screenHeight: f32,

  // Device pixel ratio — fragPos.xy is in physical framebuffer pixels, but
  // the surface textures are sized at logical+margin resolution. Divide
  // fragPos.xy by this to get logical pixel coords before texel indexing.
  pixelRatio: f32,

  time: f32,
  tideHeight: f32,

  // Bio-optical water chemistry (per-level / per-region).
  // These drive the absorption/scattering calculation in the shader.
  // Typical ranges:
  //   chlorophyll: 0.01 (open ocean) – 10 (algal bloom), mg/m³
  //   cdom:        0.0  – 1.5 (tannic/coastal), normalized
  //   sediment:    0.0  – 3.0 (turbid estuary), normalized
  chlorophyll: f32,
  cdom: f32,
  sediment: f32,

  // Runtime-tunable water shader knobs. Populated each frame from
  // WaterTuning.ts via pushWaterTuning(); exposed in the TuningPanel
  // (toggle with backslash key) so the surface look can be tuned live.
  glitterAmpCalm: f32,
  glitterAmpWindy: f32,
  glitterTime: f32,
  glitterFreqParallel: f32,
  glitterFreqPerp: f32,
  glitterPeakWind: f32,
  glitterFalloff: f32,
  specularPowerCalm: f32,
  specularPowerWindy: f32,
  sunIntensity: f32,
  slickAmp: f32,
  slickWindHigh: f32,
  horizonBlend: f32,

  // Scene lighting (see SceneLighting.ts). Populated from TimeOfDay.
  ...SCENE_LIGHTING_FIELDS,
});

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

  // Bio-optical water chemistry (per level/region)
  chlorophyll: f32,
  cdom: f32,
  sediment: f32,

  // Runtime-tunable knobs (see WaterTuning.ts).
  glitterAmpCalm: f32,
  glitterAmpWindy: f32,
  glitterTime: f32,
  glitterFreqParallel: f32,
  glitterFreqPerp: f32,
  glitterPeakWind: f32,
  glitterFalloff: f32,
  specularPowerCalm: f32,
  specularPowerWindy: f32,
  sunIntensity: f32,
  slickAmp: f32,
  slickWindHigh: f32,
  horizonBlend: f32,

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
    windFieldTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
    windFieldSampler: { type: "sampler", samplerType: "filtering" },
    // Screen-space dynamic lighting buffer. Sampled by integer fragment
    // position; the texture is canvas-pixel sized.
    lightsTexture: {
      type: "texture",
      viewDimension: "2d",
      sampleType: "float",
    },
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
// texture's clip[-1,1] over screen pixel range [-m, W+m].
fn worldToHeightUV(worldPos: vec2<f32>) -> vec2<f32> {
  let clip = (params.worldToTexClip * vec3<f32>(worldPos, 1.0)).xy;
  return vec2<f32>((clip.x + 1.0) * 0.5, (1.0 - clip.y) * 0.5);
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

  // Ocean surface data at this pixel. Bilinear-sampled at the physical
  // pixel position via worldToHeightUV — the water height texture is at
  // logical (CSS-pixel) resolution, so on retina/HiDPI displays nearest-
  // sampling collapses every 2x2 physical block onto one texel and the
  // foam/turbulence visibly pixelates. Linear sampling is safe here now
  // that the water height texture stays a continuous ocean surface
  // (boat-air substitution moved into this shader, below).
  let waterUV = worldToHeightUV(worldPos);
  let waterData = textureSampleLevel(waterHeightTexture, heightSampler, waterUV, 0.0);
  let oceanHeight = waterData.x;
  // BA channels carry the analytic surface gradient (dh/dx, dh/dy) computed
  // in WaterHeightShader. Bilinear-sampling these here gives a smooth normal
  // field — no texel-grid facets in the specular highlight.
  let waterGradient = waterData.ba;

  // Boat air substitution. BoatAirShader publishes per-pixel air gaps
  // (bilge surface Z in R, deck cap Z in G, bilge turbulence in B) at
  // pixels inside any hull footprint. Sampled with textureLoad (nearest)
  // because hull edges are real discontinuities — bilinear would smear
  // the sentinel-low background into hull-interior pixels and break the
  // air-range test. fragPos.xy is in physical framebuffer pixels; the
  // surface textures are sized at logical + margin, so divide by
  // pixelRatio before offsetting.
  let logicalCoord = vec2<i32>(fragPos.xy / params.pixelRatio);
  let waterTexel = logicalCoord + vec2<i32>(SURFACE_TEXTURE_MARGIN, SURFACE_TEXTURE_MARGIN);
  let airData = textureLoad(boatAirTexture, waterTexel, 0);
  let airMin = airData.r;
  let airMax = airData.g;
  var waterHeight = oceanHeight;
  if (airMax > airMin && oceanHeight >= airMin && oceanHeight <= airMax) {
    waterHeight = airMin;
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

  // Sample local wind for specular roughness scaling.
  // Wind texture is co-located with the water height texture (same UV mapping).
  let windUV0 = worldToHeightUV(worldPos);
  let windSample0 = textureSampleLevel(windFieldTexture, windFieldSampler, windUV0, 0.0);
  let windVel0 = windSample0.xy;
  let windSpeed0 = windSample0.z;

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
    let depthForMod = select(1000.0, max(submersion, 0.0), scenePresent);
    let shallowFactor = 1.0 + 2.0 * exp(-depthForMod * 0.15);

    let localChl = params.chlorophyll * shallowFactor;
    let localCdom = params.cdom * shallowFactor;
    let localSediment = params.sediment * shallowFactor;

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

    // Surface: Fresnel-weighted mix of transmitted and sky, plus sun specular.
    // Normal is reconstructed from the bilinear-sampled analytic gradient
    // (computed exactly per texel in WaterHeightShader) — no finite-diff of
    // bilinear-interpolated heights, so no texel-grid facet artifacts in
    // the highlight.
    var waterNormal = normalize(vec3<f32>(-waterGradient.x, -waterGradient.y, 1.0));

    // -----------------------------------------------------------------
    // Wind-driven surface shading
    // -----------------------------------------------------------------
    // Reuse the wind sample taken earlier for steepness whitecap logic.
    let windVel = windVel0;
    let windSpeed = windSpeed0;

    // Glassy slick patches: large slow-moving regions (~100 ft scale,
    // evolving over ~20s) where below-Beaufort-1 conditions allow the
    // surface tension to dominate over wind chop. Only forms where wind
    // is below ~6 ft/s (~3.5 kts), full slick by ~2 ft/s.
    let slickNoise = simplex3D(vec3<f32>(worldPos.x * 0.01, worldPos.y * 0.01, params.time * 0.05));
    let lowWindFactor = 1.0 - smoothstep(2.0, params.slickWindHigh, windSpeed);
    let slickAmount = lowWindFactor * smoothstep(0.0, 0.4, slickNoise) * params.slickAmp;

    // -----------------------------------------------------------------
    // Sun-aligned high-frequency facet glitter (#27)
    // -----------------------------------------------------------------
    // Real sun on water shows a downwind streak of pinprick glints, not
    // a smooth highlight cone. Each glint is a single wave facet whose
    // normal happens to align with the half-vector. We simulate this by
    // perturbing the surface normal *along the sun's in-plane direction*
    // at very high frequency — pow(n·h, specularPower) then amplifies the
    // few facets that line up with the sun into bright pinprick highlights.
    //
    // Perturbation is along the sun direction only (not isotropic). An
    // isotropic noise just blurs the highlight; a sun-aligned shear is
    // what creates the streak-of-glints look. Sub-foot frequency (~1.6 ft
    // wavelength on the primary octave at 0.6 cycles/ft) ensures many
    // facets per pixel so individual glints stand out crisply.
    let sunDir2D = params.sunDirection.xy;
    let sunDirLen = length(sunDir2D);
    if (sunDirLen > 0.001) {
      let sunInPlane = sunDir2D / sunDirLen;
      let sunPerp = vec2<f32>(-sunInPlane.y, sunInPlane.x);
      // Coordinates rotated to sun frame. Higher freq across-sun (3.6 c/ft
      // → ~3 in cross spacing) than along-sun (0.6 c/ft → ~1.6 ft along)
      // — the resulting facet pattern is short transverse "scales", which
      // is what produces the elongated streak of glints.
      let gx = dot(worldPos, sunInPlane);
      let gy = dot(worldPos, sunPerp);
      let gFreqParA = params.glitterFreqParallel;
      let gFreqPerpA = params.glitterFreqPerp;
      let gFreqParB = gFreqParA * 2.83;
      let gFreqPerpB = gFreqPerpA * 2.22;
      let gT = params.time * params.glitterTime;
      let g1 = simplex3D(vec3<f32>(gx * gFreqParA, gy * gFreqPerpA, gT));
      let g2 = simplex3D(vec3<f32>(gx * gFreqParB + 100.0, gy * gFreqPerpB + 100.0, gT));
      let glitterNoise = g1 * 0.65 + g2 * 0.35;
      // Asymmetric peak curve: glitter ramps from calm value up to peak
      // around moderate-wind speeds, then falls off in heavier wind
      // because the surface gets rough/foamy enough that discrete facet
      // sparkles wash into broad scattered glare. Both edges use
      // smoothsteps so transitions are soft, and the min() join makes
      // the falloff start exactly at glitterPeakWind.
      let factorUp = smoothstep(0.0, params.glitterPeakWind, windSpeed);
      let factorDown = 1.0 - smoothstep(params.glitterPeakWind, params.glitterPeakWind + params.glitterFalloff, windSpeed);
      let glitterFactor = min(factorUp, factorDown);
      let glitterAmp = mix(params.glitterAmpCalm, params.glitterAmpWindy, glitterFactor)
                       * (1.0 - slickAmount * 0.85);
      let glitterPerturb = vec3<f32>(sunInPlane * glitterNoise * glitterAmp, 0.0);
      waterNormal = normalize(waterNormal + glitterPerturb);
    }

    // Wind-driven specular roughness. Beaufort calibration:
    //   0 ft/s → 512 (mirror), 35 ft/s (~21 kts, Beaufort 5/6) → 16
    //   (broad scattered glare). The smoothstep matches the real-world
    //   transition from glassy through ripple to whitecaps.
    var specularPower = mix(params.specularPowerCalm, params.specularPowerWindy, smoothstep(0.0, 35.0, windSpeed));
    // Slick patches stay mirror-sharp regardless of base wind so they
    // visibly catch the sun like polished glass.
    specularPower = mix(specularPower, max(specularPower, 1024.0), slickAmount);

    let viewDir = vec3<f32>(0.0, 0.0, 1.0);
    // horizonBlend = 0 collapses the two-tone sky back to a single
    // zenith color (lets you toggle the horizon-mixing feature off).
    let effectiveHorizon = mix(params.skyColor, params.horizonSkyColor, params.horizonBlend);
    finalColor = waterSurfaceLight(
      waterNormal,
      viewDir,
      transmitted,
      params.sunDirection,
      params.sunColor,
      params.skyColor,
      effectiveHorizon,
      specularPower,
      params.sunIntensity,
    );

    // Write water surface z to depth so post-water particles sort correctly.
    surfaceZ = max(waterHeight, sceneZ);
  }

  // Screen-space dynamic lighting contribution. Screen-blend with the
  // water optics output so a fully-white-at-full-intensity light caps the
  // pixel at (1,1,1) — never overshooting full illumination. Same
  // saturation contract as the boat shape shader and the terrain
  // composite.
  let lightSample = clamp(
    textureLoad(lightsTexture, vec2<i32>(fragPos.xy), 0).rgb,
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  finalColor = vec3<f32>(1.0) - (vec3<f32>(1.0) - clamp(finalColor, vec3<f32>(0.0), vec3<f32>(1.0))) * (vec3<f32>(1.0) - lightSample);

  // Anti-banding dither at the final stop before quantization. Magnitude
  // is tied to one quantization step (1/255) so it's imperceptible but
  // enough to break the 8-bit steps in dim gradients (twilight sky,
  // absorbed water, foam fade). Time-reseeded so it never settles into a
  // visible pattern.
  let ditherSeed = floor(fragPos.xy) + vec2<f32>(params.time * 71.0, params.time * 113.0);
  let ditherNoise = hash21(ditherSeed) - 0.5;
  finalColor = finalColor + vec3<f32>(ditherNoise / 255.0);

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
