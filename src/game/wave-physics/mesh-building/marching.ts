/**
 * Wavefront marching via independent ray tracing.
 *
 * Algorithm overview:
 *
 * 1. An initial wavefront is a line of evenly-spaced points along the upwave
 *    edge of the domain, all facing the base wave direction.
 *
 * 2. Each point is an independent ray. At each step, the ray:
 *    a. Computes the local wave speed from the water depth (dispersion relation)
 *    b. Computes the depth gradient via finite differences on the terrain
 *    c. Rotates its direction via Snell's law: dθ/ds = -(1/c) * ∂c/∂n
 *       where ∂c/∂n is the speed gradient perpendicular to the ray
 *    d. Advances by stepSize * speedFactor in its (updated) direction
 *
 *    Rays do NOT influence each other's direction. The wavefront is purely a
 *    bookkeeping structure for triangulation — not a physics input.
 *
 * 3. After each step, a refinement pass merges points that have bunched up
 *    (ray convergence near caustics) to keep the mesh well-conditioned.
 *
 * 4. Energy tracking: rays passing over terrain lose energy exponentially
 *    based on the terrain height above water. This is the only thing tracked
 *    during marching — amplitude is computed in a separate pass afterward.
 *
 * 5. Amplitude computation (separate pass after marching):
 *    amplitude = energy * shoaling * divergence
 *    - energy:     surviving fraction after terrain attenuation
 *    - shoaling:   depth-based amplification (waves get taller in shallow water)
 *    - divergence: ray spacing factor (energy spreads as rays diverge)
 */

import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";
import type { WaveBounds, Wavefront, WavefrontSegment } from "./marchingTypes";
import {
  computeTerrainHeight,
  computeTerrainHeightAndGradient,
  type TerrainHeightGradient,
} from "../../world/terrain/terrainHeightCPU";

/** Energy fraction below which a point is considered dead */
const MIN_ENERGY = 0.005;

/** Rate of energy decay when wave passes over terrain */
const TERRAIN_DECAY_RATE = 0.5;

/** Merge points closer than this fraction of vertex spacing */
const MERGE_RATIO = 0.3;

/**
 * Split threshold for original (level-0) rays: two original rays will split
 * when their distance exceeds vertexSpacing × BASE_SPLIT_RATIO.
 */
const BASE_SPLIT_RATIO = 1.75;

/**
 * Per-level escalation of the split threshold. Each split halves the t-gap
 * between rays, creating a new "split level". At level n, the threshold is
 * BASE_SPLIT_RATIO × SPLIT_ESCALATION^n × vertexSpacing. For example:
 *   level 0 (original rays): 1.5  × vertexSpacing
 *   level 1 (first split):   2.25 × vertexSpacing  (×1.5)
 *   level 2 (second split):  3.38 × vertexSpacing  (×1.5)
 * This damps cascade splitting — deeper offspring need proportionally larger
 * gaps before they'll split again.
 */
const SPLIT_ESCALATION = 1.6;

/** Precomputed exponent: tScale^SPLIT_ESCALATION_EXP = SPLIT_ESCALATION^depth */
const SPLIT_ESCALATION_EXP = Math.log2(SPLIT_ESCALATION);

/** Upper bound on the effective split ratio for deeply-nested split offspring. */
const MAX_SPLIT_RATIO = 16.0;

/** Maximum number of midpoints to insert per segment per refinement pass */
const MAX_SPLITS_PER_SEGMENT = 100;

/** Hard cap on total points in a single segment — no splitting beyond this */
const MAX_SEGMENT_POINTS = 5000;

/** Minimum energy for both endpoints to allow splitting between them */
const MIN_SPLIT_ENERGY = 0.1;

/** Maximum angular change per step (radians), prevents wild rotation */
const MAX_TURN_PER_STEP = Math.PI / 4;

/** Stability limit for explicit diffusion scheme */
const MAX_DIFFUSION_D = 0.5;

/** Number of diffusion iterations per march step. Higher = stronger diffraction.
 *  1 is physically motivated; crank up for testing. */
const DIFFRACTION_ITERATIONS = 10;

/** Minimum march speed as fraction of deep water speed */
const MIN_SPEED_FACTOR = 0.25;

/** Maximum amplification from any single factor (shoaling or convergence) */
const MAX_AMPLIFICATION = 2.0;

/** Waves break when depth falls below this fraction of wavelength */
const BREAKING_DEPTH_RATIO = 0.07;

/** Energy decay rate per normalized step once a wave has broken */
const BREAKING_DECAY_RATE = 1.2;

function createEmptySegment(): WavefrontSegment {
  return {
    x: [],
    y: [],
    t: [],
    dirX: [],
    dirY: [],
    energy: [],
    broken: [],
    depth: [],
    amplitude: [],
  };
}

/** Normalized wave speed (c/c_deep) from water depth. Returns 0 for dry land. */
function normalizedSpeed(depth: number, k: number): number {
  if (depth <= 0) return 0;
  return Math.sqrt(Math.tanh(k * depth));
}

/**
 * Shoaling coefficient K_s for a given depth and wavenumber.
 * In shallow water waves slow down and get taller (K_s > 1).
 * In deep water K_s ≈ 1 (no effect).
 */
function computeShoalingFactor(depth: number, k: number): number {
  const kh = k * depth;
  if (kh > 10) return 1.0;

  // Group velocity factor: n = c_g / c = 0.5 * (1 + 2kh / sinh(2kh))
  const sinh2kh = Math.sinh(2 * kh);
  const n = 0.5 * (1 + (2 * kh) / sinh2kh);

  // K_s = 1 / sqrt(2n * tanh(kh))
  return 1 / Math.sqrt(2 * n * Math.tanh(kh));
}

/**
 * Generate the initial wavefront: a line of evenly-spaced points along the
 * upwave edge of the domain, perpendicular to the wave direction.
 * All rays start facing the base wave direction.
 */
export function generateInitialWavefront(
  bounds: WaveBounds,
  vertexSpacing: number,
  waveDx: number,
  waveDy: number,
): WavefrontSegment {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefrontWidth = bounds.maxPerp - bounds.minPerp;

  const numVertices = Math.max(
    3,
    Math.ceil(wavefrontWidth / vertexSpacing) + 1,
  );

  const x = new Array<number>(numVertices);
  const y = new Array<number>(numVertices);
  const t = new Array<number>(numVertices);
  const dirX = new Array<number>(numVertices);
  const dirY = new Array<number>(numVertices);
  const energy = new Array<number>(numVertices);
  const broken = new Array<number>(numVertices);
  const depth = new Array<number>(numVertices);
  const amplitude = new Array<number>(numVertices);

  for (let i = 0; i < numVertices; i++) {
    const ti = i / (numVertices - 1);
    const perpPos = bounds.minPerp + ti * wavefrontWidth;
    x[i] = bounds.minProj * waveDx + perpPos * perpDx;
    y[i] = bounds.minProj * waveDy + perpPos * perpDy;
    t[i] = ti;
    dirX[i] = waveDx;
    dirY[i] = waveDy;
    energy[i] = 1.0;
    broken[i] = 0;
    depth[i] = 0;
    amplitude[i] = 0;
  }

  return { x, y, t, dirX, dirY, energy, broken, depth, amplitude };
}

/**
 * Merge points that have bunched up and split points that have diverged,
 * in a single pass that builds a new segment.
 */
function refineWavefront(
  wavefront: WavefrontSegment,
  vertexSpacing: number,
  initialDeltaT: number,
  stats: { splits: number; merges: number },
): WavefrontSegment {
  const srcX = wavefront.x;
  const srcLen = srcX.length;
  if (srcLen <= 1) return wavefront;

  const srcY = wavefront.y;
  const srcT = wavefront.t;
  const srcDirX = wavefront.dirX;
  const srcDirY = wavefront.dirY;
  const srcEnergy = wavefront.energy;
  const srcBroken = wavefront.broken;
  const srcDepth = wavefront.depth;

  const minDistSq = (vertexSpacing * MERGE_RATIO) ** 2;
  const canSplit = srcLen < MAX_SEGMENT_POINTS;

  const result = createEmptySegment();
  const outX = result.x;
  const outY = result.y;
  const outT = result.t;
  const outDirX = result.dirX;
  const outDirY = result.dirY;
  const outEnergy = result.energy;
  const outBroken = result.broken;
  const outDepth = result.depth;
  const outAmplitude = result.amplitude;

  outX.push(srcX[0]);
  outY.push(srcY[0]);
  outT.push(srcT[0]);
  outDirX.push(srcDirX[0]);
  outDirY.push(srcDirY[0]);
  outEnergy.push(srcEnergy[0]);
  outBroken.push(srcBroken[0]);
  outDepth.push(srcDepth[0]);
  outAmplitude.push(0);

  let splitCount = 0;

  for (let i = 1; i < srcLen; i++) {
    const prevIdx = outX.length - 1;
    const prevX = outX[prevIdx];
    const prevY = outY[prevIdx];
    const prevT = outT[prevIdx];
    const prevDirX = outDirX[prevIdx];
    const prevDirY = outDirY[prevIdx];
    const prevEnergy = outEnergy[prevIdx];
    const prevBroken = outBroken[prevIdx];
    const prevDepth = outDepth[prevIdx];

    const currX = srcX[i];
    const currY = srcY[i];
    const currT = srcT[i];
    const currDirX = srcDirX[i];
    const currDirY = srcDirY[i];
    const currEnergy = srcEnergy[i];
    const currBroken = srcBroken[i];
    const currDepth = srcDepth[i];

    const dx = currX - prevX;
    const dy = currY - prevY;
    const distSq = dx * dx + dy * dy;

    if (distSq < minDistSq) {
      stats.merges++;
      continue;
    }

    // Split depth from t-gap: each split halves deltaT, so depth = log2(tScale).
    // Threshold escalates by SPLIT_ESCALATION per depth level.
    const deltaT = Math.abs(currT - prevT);
    const tScale = deltaT > 1e-12 ? initialDeltaT / deltaT : MAX_SPLIT_RATIO;
    const escalation = Math.pow(tScale, SPLIT_ESCALATION_EXP);
    const effectiveRatio = Math.min(
      MAX_SPLIT_RATIO,
      BASE_SPLIT_RATIO * escalation,
    );
    const maxDistSq = (vertexSpacing * effectiveRatio) ** 2;

    // Split: insert interpolated midpoint when gap is too large.
    // Skip if either endpoint has low energy — midpoints placed on dying rays
    // (e.g. over terrain) tend to diverge and cause runaway splitting.
    if (
      canSplit &&
      distSq > maxDistSq &&
      splitCount < MAX_SPLITS_PER_SEGMENT &&
      prevEnergy >= MIN_SPLIT_ENERGY &&
      currEnergy >= MIN_SPLIT_ENERGY
    ) {
      let midDirX = prevDirX + currDirX;
      let midDirY = prevDirY + currDirY;
      const len = Math.sqrt(midDirX * midDirX + midDirY * midDirY);
      if (len > 0) {
        midDirX /= len;
        midDirY /= len;
      }

      outX.push((prevX + currX) / 2);
      outY.push((prevY + currY) / 2);
      outT.push((prevT + currT) / 2);
      outDirX.push(midDirX);
      outDirY.push(midDirY);
      outEnergy.push((prevEnergy + currEnergy) / 2);
      outBroken.push(Math.max(prevBroken, currBroken));
      outDepth.push((prevDepth + currDepth) / 2);
      outAmplitude.push(0);

      splitCount++;
      stats.splits++;
    }

    outX.push(currX);
    outY.push(currY);
    outT.push(currT);
    outDirX.push(currDirX);
    outDirY.push(currDirY);
    outEnergy.push(currEnergy);
    outBroken.push(currBroken);
    outDepth.push(currDepth);
    outAmplitude.push(0);
  }

  if (!canSplit) {
    console.warn(
      `[marching] Segment has ${srcLen} points (max ${MAX_SEGMENT_POINTS}), splitting disabled.`,
    );
  } else if (splitCount >= MAX_SPLITS_PER_SEGMENT) {
    console.warn(
      `[marching] Split limit reached (${MAX_SPLITS_PER_SEGMENT} per segment). ` +
        `Rays may be diverging excessively.`,
    );
  }

  return result;
}

/**
 * Lateral amplitude diffusion along a wavefront segment (diffraction).
 *
 * Boundary conditions:
 * - Domain edges (t ≈ 0 or t ≈ 1): open ocean, ghost amplitude = 1.0
 * - Shadow edges (segment broke due to dead rays): ghost amplitude = 0 (fade out)
 */
function diffuseSegment(
  segment: WavefrontSegment,
  D: number,
  initialDeltaT: number,
  scratch: Float64Array<ArrayBufferLike>,
): Float64Array<ArrayBufferLike> {
  const t = segment.t;
  const amplitude = segment.amplitude;
  const n = t.length;
  if (n <= 1) return scratch;

  // Domain-edge detection: rays near t=0 or t=1 border open ocean
  const edgeThreshold = initialDeltaT * 0.5;
  const leftIsDomainEdge = t[0] < edgeThreshold;
  const rightIsDomainEdge = t[n - 1] > 1 - edgeThreshold;

  let old = scratch;
  if (old.length < n) {
    old = new Float64Array(n);
  }

  for (let iter = 0; iter < DIFFRACTION_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) old[i] = amplitude[i];

    for (let i = 0; i < n; i++) {
      const left = i > 0 ? old[i - 1] : leftIsDomainEdge ? 1.0 : 0;
      const right = i < n - 1 ? old[i + 1] : rightIsDomainEdge ? 1.0 : 0;
      amplitude[i] = Math.max(0, old[i] + D * (left - 2 * old[i] + right));
    }
  }

  return old;
}

/**
 * Post-march lateral diffusion of amplitude across wavefronts (diffraction).
 *
 * Runs after computeAmplitudes. At each wavefront step, amplitude is smoothed
 * laterally via the parabolic approximation: ∂A/∂s = (1/2k) · ∂²A/∂n².
 *
 * This must run post-march rather than during marching, because during marching
 * terrain attenuation acts as an energy sink — lateral diffusion would feed
 * energy toward terrain where it gets absorbed, making shadows grow rather
 * than shrink.
 */
export function applyDiffraction(
  wavefronts: Wavefront[],
  wavelength: number,
  vertexSpacing: number,
  stepSize: number,
  initialDeltaT: number,
): void {
  const k = (2 * Math.PI) / wavelength;

  // D = Δs / (2k · Δn²) — longer wavelengths (smaller k) diffract more
  const D = Math.min(MAX_DIFFUSION_D, stepSize / (2 * k * vertexSpacing ** 2));
  let scratch: Float64Array<ArrayBufferLike> = new Float64Array(0);

  for (const step of wavefronts) {
    for (const segment of step) {
      scratch = diffuseSegment(segment, D, initialDeltaT, scratch);
    }
  }
}

/**
 * March wavefronts step-by-step until all rays leave the domain or die.
 * Each ray advances independently, turning via Snell's law based on the
 * local depth gradient. Amplitude and diffraction are applied row-by-row
 * as rows are produced.
 */
export function marchWavefronts(
  firstWavefront: WavefrontSegment,
  waveDx: number,
  waveDy: number,
  stepSize: number,
  vertexSpacing: number,
  bounds: WaveBounds,
  terrain: TerrainCPUData,
  wavelength: number,
): {
  wavefronts: Wavefront[];
  splits: number;
  merges: number;
  amplitudeMs: number;
  diffractionMs: number;
} {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefronts: Wavefront[] = [[firstWavefront]];
  const k = (2 * Math.PI) / wavelength;
  const terrainGradientSample: TerrainHeightGradient = {
    height: 0,
    gradientX: 0,
    gradientY: 0,
  };
  const stats = { splits: 0, merges: 0 };
  const initialDeltaT =
    firstWavefront.t.length > 1 ? firstWavefront.t[1] - firstWavefront.t[0] : 1;
  const singleStep: Wavefront[] = [];
  let amplitudeMs = 0;
  let diffractionMs = 0;

  const minProj = bounds.minProj;
  const maxProj = bounds.maxProj;
  const minPerp = bounds.minPerp;
  const maxPerp = bounds.maxPerp;
  const breakingDepth = BREAKING_DEPTH_RATIO * wavelength;

  const postProcessStep = (step: Wavefront): void => {
    singleStep[0] = step;
    const tA = performance.now();
    computeAmplitudes(singleStep, wavelength, vertexSpacing, initialDeltaT);
    const tB = performance.now();
    applyDiffraction(
      singleStep,
      wavelength,
      vertexSpacing,
      stepSize,
      initialDeltaT,
    );
    const tC = performance.now();
    amplitudeMs += tB - tA;
    diffractionMs += tC - tB;
  };

  // Keep boundary-row behavior consistent with full-pass post-processing.
  postProcessStep(wavefronts[0]);

  for (;;) {
    const prevStep = wavefronts[wavefronts.length - 1];
    const nextStep: Wavefront = [];

    for (const segment of prevStep) {
      const srcX = segment.x;
      const srcY = segment.y;
      const srcT = segment.t;
      const srcDirX = segment.dirX;
      const srcDirY = segment.dirY;
      const srcEnergy = segment.energy;
      const srcBroken = segment.broken;
      const srcLen = srcX.length;

      let currentSegment = createEmptySegment();
      let outX = currentSegment.x;
      let outY = currentSegment.y;
      let outT = currentSegment.t;
      let outDirX = currentSegment.dirX;
      let outDirY = currentSegment.dirY;
      let outEnergy = currentSegment.energy;
      let outBroken = currentSegment.broken;
      let outDepth = currentSegment.depth;
      let outAmplitude = currentSegment.amplitude;

      const flushCurrentSegment = (): void => {
        if (outX.length === 0) return;
        nextStep.push(
          refineWavefront(currentSegment, vertexSpacing, initialDeltaT, stats),
        );
        currentSegment = createEmptySegment();
        outX = currentSegment.x;
        outY = currentSegment.y;
        outT = currentSegment.t;
        outDirX = currentSegment.dirX;
        outDirY = currentSegment.dirY;
        outEnergy = currentSegment.energy;
        outBroken = currentSegment.broken;
        outDepth = currentSegment.depth;
        outAmplitude = currentSegment.amplitude;
      };

      for (let i = 0; i < srcLen; i++) {
        const startEnergy = srcEnergy[i];
        if (startEnergy < MIN_ENERGY) {
          flushCurrentSegment();
          continue;
        }

        const px = srcX[i];
        const py = srcY[i];
        const pt = srcT[i];

        // Water depth and local terrain gradient at current position
        const terrainH = computeTerrainHeightAndGradient(
          px,
          py,
          terrain,
          terrainGradientSample,
        ).height;
        const currentDepth = Math.max(0, -terrainH);
        const baseSpeed = normalizedSpeed(currentDepth, k);
        const currentSpeed = Math.max(MIN_SPEED_FACTOR, baseSpeed);
        const localStep = stepSize * currentSpeed;

        let dirX = srcDirX[i];
        let dirY = srcDirY[i];

        // Apply Snell's law refraction when underwater.
        // On terrain, skip — there's no meaningful depth gradient to refract from.
        if (currentDepth > 0) {
          // c(depth) = sqrt(tanh(k*depth)), depth = -height.
          // dc/dx = (dc/ddepth) * ddepth/dx = -(dc/ddepth) * dheight/dx
          const tanhKd = baseSpeed * baseSpeed;
          const sech2Kd = 1 - tanhKd * tanhKd;
          const dcDDepth =
            baseSpeed > 1e-6 ? (k * sech2Kd) / (2 * baseSpeed) : 0;
          const dcdx = -dcDDepth * terrainGradientSample.gradientX;
          const dcdy = -dcDDepth * terrainGradientSample.gradientY;

          // Component of speed gradient perpendicular to ray direction
          const dcPerp = -dcdx * dirY + dcdy * dirX;

          // Snell's law: dθ = -(1/c) * ∂c/∂n * ds
          const dTheta = Math.max(
            -MAX_TURN_PER_STEP,
            Math.min(
              MAX_TURN_PER_STEP,
              -(1 / currentSpeed) * dcPerp * localStep,
            ),
          );

          const cosD = Math.cos(dTheta);
          const sinD = Math.sin(dTheta);
          const baseDirX = srcDirX[i];
          const baseDirY = srcDirY[i];
          dirX = baseDirX * cosD - baseDirY * sinD;
          dirY = baseDirX * sinD + baseDirY * cosD;
        }

        // Advance along ray direction
        const nx = px + dirX * localStep;
        const ny = py + dirY * localStep;

        // Bounds check in wave-aligned coordinates
        const proj = nx * waveDx + ny * waveDy;
        const perp = nx * perpDx + ny * perpDy;
        if (
          proj < minProj ||
          proj > maxProj ||
          perp < minPerp ||
          perp > maxPerp
        ) {
          flushCurrentSegment();
          continue;
        }

        // Update energy (dissipative losses only)
        const newTerrainH = computeTerrainHeight(nx, ny, terrain);
        const newDepth = -newTerrainH;
        const normalizedStep = localStep / wavelength;

        let energy = startEnergy;
        let broken = srcBroken[i];

        if (newDepth <= 0) {
          // Over terrain: exponential decay based on terrain height
          const terrainAboveWater = -newDepth;
          energy *= Math.exp(
            -terrainAboveWater * k * TERRAIN_DECAY_RATE * normalizedStep,
          );
        }

        // Breaking: ramps up as depth falls below threshold, never decreases
        if (newDepth > 0 && newDepth < breakingDepth) {
          broken = Math.max(broken, 1.0 - newDepth / breakingDepth);
        }

        // Broken waves continuously lose energy
        if (broken > 0) {
          energy *= Math.exp(-BREAKING_DECAY_RATE * normalizedStep);
        }

        outX.push(nx);
        outY.push(ny);
        outT.push(pt);
        outDirX.push(dirX);
        outDirY.push(dirY);
        outEnergy.push(energy);
        outBroken.push(broken);
        outDepth.push(Math.max(0, newDepth));
        outAmplitude.push(0);
      }

      if (outX.length > 0) {
        nextStep.push(
          refineWavefront(currentSegment, vertexSpacing, initialDeltaT, stats),
        );
      }
    }

    if (nextStep.length === 0) break;
    postProcessStep(nextStep);
    wavefronts.push(nextStep);
  }

  return {
    wavefronts,
    splits: stats.splits,
    merges: stats.merges,
    amplitudeMs,
    diffractionMs,
  };
}

/**
 * Compute amplitude for every point in the wavefronts.
 * Combines three independent factors:
 * - energy:     surviving fraction after dissipative losses (from marching)
 * - shoaling:   depth-based amplification (waves get taller in shallow water)
 * - divergence: ratio of expected spacing (from t) to actual physical spacing,
 *               so that split midpoints don't get artificially amplified
 */
export function computeAmplitudes(
  wavefronts: Wavefront[],
  wavelength: number,
  vertexSpacing: number,
  initialDeltaT: number,
): void {
  const k = (2 * Math.PI) / wavelength;
  // Physical spacing per unit t in the initial wavefront
  const spacingPerT = vertexSpacing / initialDeltaT;

  for (const step of wavefronts) {
    for (const wf of step) {
      const x = wf.x;
      const y = wf.y;
      const t = wf.t;
      const depth = wf.depth;
      const energy = wf.energy;
      const amplitude = wf.amplitude;
      const n = x.length;
      if (n === 0) continue;

      for (let i = 0; i < n; i++) {
        const pDepth = depth[i];
        const shoaling =
          pDepth > 0
            ? Math.min(computeShoalingFactor(pDepth, k), MAX_AMPLIFICATION)
            : 1.0;

        let localSpacing: number;
        let deltaT: number;
        if (n <= 1) {
          localSpacing = vertexSpacing;
          deltaT = initialDeltaT;
        } else if (i === 0) {
          const dx = x[0] - x[1];
          const dy = y[0] - y[1];
          localSpacing = Math.sqrt(dx * dx + dy * dy);
          deltaT = t[1] - t[0];
        } else if (i === n - 1) {
          const prev = n - 2;
          const dx = x[n - 1] - x[prev];
          const dy = y[n - 1] - y[prev];
          localSpacing = Math.sqrt(dx * dx + dy * dy);
          deltaT = t[n - 1] - t[prev];
        } else {
          const prev = i - 1;
          const next = i + 1;
          const dxPrev = x[i] - x[prev];
          const dyPrev = y[i] - y[prev];
          const dPrev = Math.sqrt(dxPrev * dxPrev + dyPrev * dyPrev);
          const dxNext = x[i] - x[next];
          const dyNext = y[i] - y[next];
          const dNext = Math.sqrt(dxNext * dxNext + dyNext * dyNext);
          localSpacing = (dPrev + dNext) / 2;
          deltaT = (t[next] - t[prev]) / 2;
        }

        const expectedSpacing = deltaT * spacingPerT;
        const divergence = Math.min(
          MAX_AMPLIFICATION,
          Math.sqrt(expectedSpacing / localSpacing),
        );

        amplitude[i] = energy[i] * shoaling * divergence;
      }
    }
  }
}
