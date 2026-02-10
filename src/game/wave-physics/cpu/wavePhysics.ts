/**
 * CPU port of wave physics functions.
 *
 * Pure TypeScript functions ported 1:1 from the WGSL shaders:
 * - wave-physics.wgsl.ts: computeWaveSpeed, computeRefractionOffset
 * - wave-terrain.wgsl.ts: computeShoalingFactor, computeDampingFactor, computeWaveTerrainFactor
 *
 * No engine imports — safe for use in web workers.
 */

/** Gravitational acceleration in ft/s^2 */
const GRAVITY = 32.174;

/** 2 * PI */
const TWO_PI = 2 * Math.PI;

// =============================================================================
// Wave speed (from wave-physics.wgsl.ts)
// =============================================================================

/**
 * Compute wave phase speed at a given depth.
 *
 * Deep water (depth > wavelength/2): c = sqrt(g*lambda/(2*PI))
 * Shallow water (depth < wavelength/20): c = sqrt(g*d)
 * Intermediate: full dispersion relation via tanh
 */
export function computeWaveSpeed(wavelength: number, depth: number): number {
  const k = TWO_PI / wavelength;

  // Deep water threshold
  const deepWaterThreshold = wavelength * 0.5;
  if (depth >= deepWaterThreshold) {
    return Math.sqrt((GRAVITY * wavelength) / TWO_PI);
  }

  // Shallow water threshold
  const shallowWaterThreshold = wavelength * 0.05;
  if (depth <= shallowWaterThreshold) {
    return Math.sqrt(GRAVITY * Math.max(depth, 0.1));
  }

  // Intermediate depth: tanh approximation
  const kd = k * depth;
  return Math.sqrt((GRAVITY * Math.tanh(kd)) / k);
}

// =============================================================================
// Refraction (from wave-physics.wgsl.ts)
// =============================================================================

/**
 * Compute refraction-induced direction offset using Snell's Law.
 *
 * @param waveDir - incident wave direction in radians
 * @param wavelength - wave length in feet
 * @param depth - water depth at query point in feet
 * @param depthGradientX - x component of spatial depth gradient
 * @param depthGradientY - y component of spatial depth gradient
 * @returns angular offset in radians to add to wave direction
 */
export function computeRefractionOffset(
  waveDir: number,
  wavelength: number,
  depth: number,
  depthGradientX: number,
  depthGradientY: number,
): number {
  const deepThreshold = wavelength * 0.5;
  const shallowThreshold = wavelength * 0.05;

  if (depth >= deepThreshold || depth <= shallowThreshold) {
    return 0;
  }

  const gradMag = Math.sqrt(
    depthGradientX * depthGradientX + depthGradientY * depthGradientY,
  );
  if (gradMag < 0.001) {
    return 0;
  }

  // Direction of depth gradient (points toward deeper water)
  const gradDirX = depthGradientX / gradMag;
  const gradDirY = depthGradientY / gradMag;

  // Wave direction vector
  const waveDx = Math.cos(waveDir);
  const waveDy = Math.sin(waveDir);

  // Component of wave direction perpendicular to depth gradient
  const perpComponent = waveDx * -gradDirY + waveDy * gradDirX;

  // Depth change rate along wave direction
  const depthChangeRate = (waveDx * gradDirX + waveDy * gradDirY) * gradMag;

  // Approximate depth at one wavelength ahead
  const depthAhead = depth + depthChangeRate * wavelength;

  // Speed ratio (Snell's Law)
  const speedHere = computeWaveSpeed(wavelength, depth);
  const speedAhead = computeWaveSpeed(wavelength, Math.max(depthAhead, 0.1));
  const speedRatio = (speedAhead - speedHere) / Math.max(speedHere, 0.1);

  // Incident angle relative to depth gradient
  const incidentAngle = Math.asin(
    Math.max(-1, Math.min(1, Math.abs(perpComponent))),
  );

  // Refraction strength: stronger in intermediate depths
  const refractionStrength =
    smoothstep(shallowThreshold, deepThreshold * 0.3, depth) *
    smoothstep(deepThreshold, deepThreshold * 0.3, depth);

  // Direction offset: waves bend toward shallower water
  const refractionOffset =
    -speedRatio * Math.sin(incidentAngle) * refractionStrength;

  return Math.max(-0.2, Math.min(0.2, refractionOffset));
}

// =============================================================================
// Wave-terrain interaction (from wave-terrain.wgsl.ts)
// =============================================================================

/**
 * Compute shoaling factor (Green's Law).
 * Waves grow taller as they enter shallow water.
 */
export function computeShoalingFactor(
  depth: number,
  wavelength: number,
): number {
  const transitionDepth = wavelength * 0.5;

  if (depth >= transitionDepth) {
    return 1;
  }

  const safeDepth = Math.max(depth, 0.5);
  const rawFactor = Math.pow(transitionDepth / safeDepth, 0.25);
  return Math.max(0, Math.min(2, rawFactor));
}

/**
 * Compute damping factor.
 * Waves lose energy in very shallow water due to breaking and bottom friction.
 */
export function computeDampingFactor(
  depth: number,
  wavelength: number,
): number {
  const dampingThreshold = wavelength * 0.05;
  const swashDepth = wavelength * 0.015;
  return smoothstep(-swashDepth, dampingThreshold, depth);
}

/**
 * Combined wave-terrain energy modifier (shoaling * damping).
 */
export function computeWaveTerrainFactor(
  depth: number,
  wavelength: number,
): number {
  if (depth !== depth) {
    return 0; // NaN check
  }

  const shoaling = depth > 0 ? computeShoalingFactor(depth, wavelength) : 1;
  const damping = computeDampingFactor(depth, wavelength);
  return shoaling * damping;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * GLSL/WGSL-compatible smoothstep function.
 * Returns 0 if x <= edge0, 1 if x >= edge1, smooth interpolation between.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
