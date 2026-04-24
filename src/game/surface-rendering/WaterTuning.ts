/**
 * Runtime-tunable knobs for the water surface shader. Each `let` is wired
 * to the TuningPanel via the //#tunable transformer; values are read each
 * frame in SurfaceRenderer and pushed to the WaterFilter uniform buffer.
 *
 * Toggle the panel with the backslash key.
 */

import type { UniformInstance } from "../../core/graphics/UniformStruct";
import type { WaterFilterUniforms } from "./WaterFilterUniforms";

// --- Sun glitter (high-frequency facet sparkle) ---
// Glitter amplitude follows a wind-speed peak curve: rises from CALM at
// 0 wind to WINDY at PEAK_WIND, then falls back over FALLOFF ft/s. This
// matches reality — discrete facet sparkles are most visible at moderate
// chop, then wash out into broad scattered glare in heavy wind.

//#tunable("Water/Glitter") { min: 0, max: 0.5, step: 0.005 }
let GLITTER_AMP_CALM = 0.0;
//#tunable("Water/Glitter") { min: 0, max: 0.5, step: 0.005 }
let GLITTER_AMP_WINDY = 0.05;
//#tunable("Water/Glitter") { min: 0, max: 2, step: 0.01 }
let GLITTER_TIME = 2.0;
//#tunable("Water/Glitter") { min: 0.05, max: 3, step: 0.05 }
let GLITTER_FREQ_PARALLEL = 0.6;
//#tunable("Water/Glitter") { min: 0.5, max: 16, step: 0.2 }
let GLITTER_FREQ_PERP = 3.6;
// Peak wind speed (ft/s) where glitter is brightest. 24 ft/s ≈ 14 kts.
//#tunable("Water/Glitter") { min: 1, max: 60, step: 1 }
let GLITTER_PEAK_WIND = 24.0;
// Falloff width (ft/s) — distance past peak before glitter fades out.
//#tunable("Water/Glitter") { min: 1, max: 60, step: 1 }
let GLITTER_FALLOFF = 18.0;

// --- Specular highlight (sun reflection) ---

//#tunable("Water/Specular") { min: 16, max: 2048, step: 16 }
let SPECULAR_POWER_CALM = 512.0;
//#tunable("Water/Specular") { min: 4, max: 256, step: 1 }
let SPECULAR_POWER_WINDY = 16.0;
//#tunable("Water/Specular") { min: 0, max: 50, step: 0.5 }
let SUN_INTENSITY = 18.0;

// --- Steepness-based whitecap source ---

//#tunable("Water/Foam") { min: 0.03, max: 0.4, step: 0.005 }
let STEEPNESS_THRESHOLD_CALM = 0.15;
//#tunable("Water/Foam") { min: 0.02, max: 0.3, step: 0.005 }
let STEEPNESS_THRESHOLD_WINDY = 0.07;

// --- Worley-based foam visualization ---

//#tunable("Water/Foam") { min: 0.1, max: 3, step: 0.05 }
let FOAM_CELL_SCALE = 0.6;
//#tunable("Water/Foam") { min: 0, max: 1, step: 0.01 }
let FOAM_COVERAGE_MAX = 0.85;
//#tunable("Water/Foam") { min: 0.005, max: 0.2, step: 0.005 }
let FOAM_BAND_WIDTH = 0.03;
//#tunable("Water/Foam") { min: 0, max: 1, step: 0.01 }
let FOAM_ENABLE = 0.0;

// --- Slick patches (low-wind glassy water) ---

//#tunable("Water/Slick") { min: 0, max: 1, step: 0.01 }
let SLICK_AMP = 1.0;
//#tunable("Water/Slick") { min: 1, max: 20, step: 0.5 }
let SLICK_WIND_HIGH = 6.0;

// --- Two-tone sky reflection ---

//#tunable("Water/Sky") { min: 0, max: 1, step: 0.01 }
let HORIZON_BLEND = 1.0;

/**
 * Push all current tuning values into the water filter uniform instance.
 * Called once per frame from SurfaceRenderer.updateWaterFilterUniforms.
 */
export function pushWaterTuning(
  uniforms: UniformInstance<typeof WaterFilterUniforms.fields>,
): void {
  uniforms.set.glitterAmpCalm(GLITTER_AMP_CALM);
  uniforms.set.glitterAmpWindy(GLITTER_AMP_WINDY);
  uniforms.set.glitterTime(GLITTER_TIME);
  uniforms.set.glitterFreqParallel(GLITTER_FREQ_PARALLEL);
  uniforms.set.glitterFreqPerp(GLITTER_FREQ_PERP);
  uniforms.set.glitterPeakWind(GLITTER_PEAK_WIND);
  uniforms.set.glitterFalloff(GLITTER_FALLOFF);

  uniforms.set.specularPowerCalm(SPECULAR_POWER_CALM);
  uniforms.set.specularPowerWindy(SPECULAR_POWER_WINDY);
  uniforms.set.sunIntensity(SUN_INTENSITY);

  uniforms.set.steepnessThresholdCalm(STEEPNESS_THRESHOLD_CALM);
  uniforms.set.steepnessThresholdWindy(STEEPNESS_THRESHOLD_WINDY);

  uniforms.set.foamCellScale(FOAM_CELL_SCALE);
  uniforms.set.foamCoverageMax(FOAM_COVERAGE_MAX);
  uniforms.set.foamBandWidth(FOAM_BAND_WIDTH);
  uniforms.set.foamEnable(FOAM_ENABLE);

  uniforms.set.slickAmp(SLICK_AMP);
  uniforms.set.slickWindHigh(SLICK_WIND_HIGH);

  uniforms.set.horizonBlend(HORIZON_BLEND);
}
