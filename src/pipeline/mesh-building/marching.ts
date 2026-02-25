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

import type { TerrainCPUData } from "../../game/world/terrain/TerrainCPUData";
import type {
  MutableWavefrontSegment,
  WaveBounds,
  Wavefront,
  WavefrontSegment,
} from "./marchingTypes";
import {
  computeTerrainHeight,
  computeTerrainHeightAndGradient,
  type TerrainHeightGradient,
} from "./terrainHeightCPU";

/** Energy fraction below which a point is considered dead */
const MIN_ENERGY = 0.03;

/** Bottom friction rate — energy dissipated by seabed interaction.
 *  Scaled by exp(-k*depth): negligible in deep water, strong in shallow water,
 *  and very aggressive over land (depth < 0 makes the exponent grow). */
const BOTTOM_FRICTION_RATE = 0.0;

/** Max energy ratio between adjacent rays before splitting the segment.
 *  Prevents low-energy land-crawling rays from being triangulated against
 *  healthy ocean rays, which creates enormous skinny triangles. */
const MAX_ENERGY_RATIO = 5;

/** Merge points closer than this fraction of vertex spacing */
const MERGE_RATIO = 0.3;

/**
 * Split threshold for original (level-0) rays: two original rays will split
 * when their distance exceeds vertexSpacing × BASE_SPLIT_RATIO.
 */
const BASE_SPLIT_RATIO = 1.5;

/**
 * Per-level escalation of the split threshold. Each split halves the t-gap
 * between rays, creating a new "split level". At level n, the threshold is
 * BASE_SPLIT_RATIO × SPLIT_ESCALATION^n × vertexSpacing. For example:
 *   level 0 (original rays): 1.75 × vertexSpacing
 *   level 1 (first split):   2.625 × vertexSpacing  (×1.5)
 *   level 2 (second split):  3.9375 × vertexSpacing  (×1.5)
 * This damps cascade splitting — deeper offspring need proportionally larger
 * gaps before they'll split again.
 */
const SPLIT_ESCALATION = 1.25;

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
const MAX_TURN_PER_STEP = 0; //Math.PI / 8;

/** Stability limit for explicit diffusion scheme */
const MAX_DIFFUSION_D = 0.5;

/** Number of diffusion iterations per march step. Higher = stronger diffraction.
 *  1 is physically motivated; crank up for testing. */
const DIFFRACTION_ITERATIONS = 0;

/** Minimum march speed as fraction of deep water speed */
const MIN_SPEED_FACTOR = 0.25;

/** Maximum amplification from any single factor (shoaling or convergence) */
const MAX_AMPLIFICATION = 2.0;

/** Waves break when depth falls below this fraction of wavelength */
const BREAKING_DEPTH_RATIO = 0.07;

/** Energy decay rate per normalized step once a wave has broken */
const BREAKING_DECAY_RATE = 1.2;

/** Energy dissipation from sharp refraction — proportional to |dTheta| per step.
 *  Captures nonlinear dissipation when wavefronts curve sharply. */
const REFRACTION_DISSIPATION = 0.0;

/** Scale factor for instantaneous turbulence to keep foam visible */
const TURBULENCE_SCALE = 8.0;

/** Along-ray turbulence decay rate per wavelength traveled.
 *  Higher = faster decay. At 2.0, turbulence halves every ~0.35 wavelengths. */
const TURBULENCE_DECAY_RATE = 2.0;

/** Number of lateral diffusion iterations for crosswave turbulence blur */
const TURBULENCE_DIFFUSION_ITERATIONS = 3;

/** Diffusion coefficient for crosswave turbulence blur.
 *  Must be <= 0.5 for stability. Lower = gentler spread. */
const TURBULENCE_DIFFUSION_D = 0.3;

/** Throttle "splitting disabled" warning to once per build */
let warnedSplitDisabled = false;

function createEmptySegment(): MutableWavefrontSegment {
  return {
    x: [],
    y: [],
    t: [],
    dirX: [],
    dirY: [],
    energy: [],
    turbulence: [],
    depth: [],
    amplitude: [],
    blend: [],
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
  const turbulence = new Array<number>(numVertices);
  const depth = new Array<number>(numVertices);
  const amplitude = new Array<number>(numVertices);
  const blend = new Array<number>(numVertices);

  for (let i = 0; i < numVertices; i++) {
    const ti = i / (numVertices - 1);
    const perpPos = bounds.minPerp + ti * wavefrontWidth;
    x[i] = bounds.minProj * waveDx + perpPos * perpDx;
    y[i] = bounds.minProj * waveDy + perpPos * perpDy;
    t[i] = ti;
    dirX[i] = waveDx;
    dirY[i] = waveDy;
    energy[i] = 1.0;
    turbulence[i] = 0;
    depth[i] = 0;
    amplitude[i] = 0;
    blend[i] = 0; // Initial wavefront is at the upwave boundary (distToUpwave=0)
  }

  return { x, y, t, dirX, dirY, energy, turbulence, depth, amplitude, blend };
}

/**
 * Merge points that have bunched up and split points that have diverged,
 * in a single pass that builds a new segment.
 */
function refineWavefront(
  wavefront: MutableWavefrontSegment,
  vertexSpacing: number,
  initialDeltaT: number,
  stats: { splits: number; merges: number },
): MutableWavefrontSegment {
  const srcX = wavefront.x;
  const srcLen = srcX.length;
  if (srcLen <= 1) return wavefront;

  const srcY = wavefront.y;
  const srcT = wavefront.t;
  const srcDirX = wavefront.dirX;
  const srcDirY = wavefront.dirY;
  const srcEnergy = wavefront.energy;
  const srcTurbulence = wavefront.turbulence;
  const srcDepth = wavefront.depth;
  const srcBlend = wavefront.blend;

  const minDistSq = (vertexSpacing * MERGE_RATIO) ** 2;
  const canSplit = srcLen < MAX_SEGMENT_POINTS;

  const result = createEmptySegment();
  const outX = result.x;
  const outY = result.y;
  const outT = result.t;
  const outDirX = result.dirX;
  const outDirY = result.dirY;
  const outEnergy = result.energy;
  const outTurbulence = result.turbulence;
  const outDepth = result.depth;
  const outAmplitude = result.amplitude;
  const outBlend = result.blend;

  outX.push(srcX[0]);
  outY.push(srcY[0]);
  outT.push(srcT[0]);
  outDirX.push(srcDirX[0]);
  outDirY.push(srcDirY[0]);
  outEnergy.push(srcEnergy[0]);
  outTurbulence.push(srcTurbulence[0]);
  outDepth.push(srcDepth[0]);
  outAmplitude.push(0);
  outBlend.push(srcBlend[0]);

  let splitCount = 0;

  for (let i = 1; i < srcLen; i++) {
    const prevIdx = outX.length - 1;
    const prevX = outX[prevIdx];
    const prevY = outY[prevIdx];
    const prevT = outT[prevIdx];
    const prevDirX = outDirX[prevIdx];
    const prevDirY = outDirY[prevIdx];
    const prevEnergy = outEnergy[prevIdx];
    const prevTurbulence = outTurbulence[prevIdx];
    const prevDepth = outDepth[prevIdx];
    const prevBlend = outBlend[prevIdx];

    const currX = srcX[i];
    const currY = srcY[i];
    const currT = srcT[i];
    const currDirX = srcDirX[i];
    const currDirY = srcDirY[i];
    const currEnergy = srcEnergy[i];
    const currTurbulence = srcTurbulence[i];
    const currDepth = srcDepth[i];
    const currBlend = srcBlend[i];

    const dx = currX - prevX;
    const dy = currY - prevY;
    const distSq = dx * dx + dy * dy;

    // Never merge sentinel rays (t=0 or t=1)
    if (
      distSq < minDistSq &&
      prevT !== 0 &&
      prevT !== 1 &&
      currT !== 0 &&
      currT !== 1
    ) {
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
    // Never split across a sentinel boundary
    const prevIsSentinel = prevT === 0 || prevT === 1;
    const currIsSentinel = currT === 0 || currT === 1;
    if (
      canSplit &&
      distSq > maxDistSq &&
      splitCount < MAX_SPLITS_PER_SEGMENT &&
      prevEnergy >= MIN_SPLIT_ENERGY &&
      currEnergy >= MIN_SPLIT_ENERGY &&
      !prevIsSentinel &&
      !currIsSentinel
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
      outTurbulence.push((prevTurbulence + currTurbulence) / 2);
      outDepth.push((prevDepth + currDepth) / 2);
      outAmplitude.push(0);
      outBlend.push((prevBlend + currBlend) / 2);

      splitCount++;
      stats.splits++;
    }

    outX.push(currX);
    outY.push(currY);
    outT.push(currT);
    outDirX.push(currDirX);
    outDirY.push(currDirY);
    outEnergy.push(currEnergy);
    outTurbulence.push(currTurbulence);
    outDepth.push(currDepth);
    outAmplitude.push(0);
    outBlend.push(currBlend);
  }

  if (!canSplit && !warnedSplitDisabled) {
    warnedSplitDisabled = true;
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
 * Lateral diffusion of turbulence across a wavefront segment.
 * Spreads foam sideways from breaking zones. Boundary conditions are 0
 * at both edges (foam doesn't leak out of segments).
 */
function diffuseTurbulenceSegment(
  segment: WavefrontSegment,
  scratch: Float64Array<ArrayBufferLike>,
): Float64Array<ArrayBufferLike> {
  const turbulence = segment.turbulence;
  const n = turbulence.length;
  if (n <= 2) return scratch;

  let old = scratch;
  if (old.length < n) {
    old = new Float64Array(n);
  }

  const D = TURBULENCE_DIFFUSION_D;
  for (let iter = 0; iter < TURBULENCE_DIFFUSION_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) old[i] = turbulence[i];

    for (let i = 0; i < n; i++) {
      const left = i > 0 ? old[i - 1] : 0;
      const right = i < n - 1 ? old[i + 1] : 0;
      turbulence[i] = Math.max(0, old[i] + D * (left - 2 * old[i] + right));
    }
  }

  return old;
}

/**
 * Apply crosswave turbulence diffusion to a wavefront step.
 */
function diffuseTurbulence(step: Wavefront): void {
  let scratch: Float64Array<ArrayBufferLike> = new Float64Array(0);
  for (const segment of step) {
    scratch = diffuseTurbulenceSegment(segment, scratch);
  }
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
 * Compact a fully post-processed wavefront step to reduce memory.
 * 1. Converts the 5 mesh-output fields (x, y, t, amplitude, turbulence)
 *    from number[] to Float32Array (halves per-element storage)
 * 2. Strips the 4 marching-only fields (dirX, dirY, energy, depth) since
 *    they are no longer needed after marching has moved past this step.
 *
 * This reduces per-step memory by ~78% (5/9 fields kept × 4/8 bytes each).
 * Full vertex decimation is deferred to the post-march pass.
 */
function compactStep(step: Wavefront, compactMs: { value: number }): void {
  const t0 = performance.now();
  for (let i = 0; i < step.length; i++) {
    const segment = step[i];

    // Convert kept fields to Float32Array and strip marching-only fields
    step[i] = {
      x: new Float32Array(segment.x),
      y: new Float32Array(segment.y),
      t: new Float32Array(segment.t),
      dirX: [],
      dirY: [],
      energy: [],
      turbulence: new Float32Array(segment.turbulence),
      depth: [],
      amplitude: new Float32Array(segment.amplitude),
      blend: new Float32Array(segment.blend),
    };
  }
  compactMs.value += performance.now() - t0;
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
  compactMs: number;
  turnClampCount: number;
  totalRefractions: number;
} {
  warnedSplitDisabled = false;
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
  let turnClampCount = 0;
  let totalRefractions = 0;
  const initialDeltaT =
    firstWavefront.t.length > 1 ? firstWavefront.t[1] - firstWavefront.t[0] : 1;
  const singleStep: Wavefront[] = [];
  let amplitudeMs = 0;
  let diffractionMs = 0;
  const compactMs = { value: 0 };

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
    diffuseTurbulence(step);
    const tC = performance.now();
    amplitudeMs += tB - tA;
    diffractionMs += tC - tB;
  };

  // Progress logging — use time-based interval so first report comes quickly
  const estimatedSteps = Math.ceil(
    (bounds.maxProj - bounds.minProj) / stepSize,
  );
  let stepCount = 0;
  let marchStartTime = performance.now();
  let nextProgressTime = marchStartTime + 2000; // first report after 2s
  let totalRaySteps = 0;

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
      const srcTurbulence = segment.turbulence;
      const srcLen = srcX.length;

      let currentSegment = createEmptySegment();
      let outX = currentSegment.x;
      let outY = currentSegment.y;
      let outT = currentSegment.t;
      let outDirX = currentSegment.dirX;
      let outDirY = currentSegment.dirY;
      let outEnergy = currentSegment.energy;
      let outTurbulence = currentSegment.turbulence;
      let outDepth = currentSegment.depth;
      let outAmplitude = currentSegment.amplitude;
      let outBlend = currentSegment.blend;

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
        outTurbulence = currentSegment.turbulence;
        outDepth = currentSegment.depth;
        outAmplitude = currentSegment.amplitude;
        outBlend = currentSegment.blend;
      };

      for (let i = 0; i < srcLen; i++) {
        const startEnergy = srcEnergy[i];
        const px = srcX[i];
        const py = srcY[i];
        const pt = srcT[i];
        const isSentinel = pt === 0 || pt === 1;

        // Non-sentinel dead rays flush the segment
        if (!isSentinel && startEnergy < MIN_ENERGY) {
          flushCurrentSegment();
          continue;
        }

        if (isSentinel) {
          // Sentinel rays advance straight at full speed, no terrain interaction
          const nx = px + waveDx * stepSize;
          const ny = py + waveDy * stepSize;

          // OOB check on downwave edge only (sentinels are at lateral boundary by definition)
          const proj = nx * waveDx + ny * waveDy;
          if (proj < minProj || proj > maxProj) {
            flushCurrentSegment();
            continue;
          }

          outX.push(nx);
          outY.push(ny);
          outT.push(pt);
          outDirX.push(waveDx);
          outDirY.push(waveDy);
          outEnergy.push(1.0);
          outTurbulence.push(0);
          outDepth.push(wavelength);
          outAmplitude.push(0);
          outBlend.push(1.0);
          continue;
        }

        // --- Normal (non-sentinel) ray processing ---

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
        let absDTheta = 0;

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
          const rawDTheta = -(1 / currentSpeed) * dcPerp * localStep;
          const dTheta = Math.max(
            -MAX_TURN_PER_STEP,
            Math.min(MAX_TURN_PER_STEP, rawDTheta),
          );
          absDTheta = Math.abs(dTheta);
          totalRefractions++;
          if (Math.abs(rawDTheta) > MAX_TURN_PER_STEP) {
            turnClampCount++;
          }

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

        // Refraction dissipation: sharp direction changes lose energy.
        // Captures nonlinear dissipation from high wavefront curvature.
        if (absDTheta > 0) {
          energy *= Math.exp(-REFRACTION_DISSIPATION * absDTheta);
        }

        // Bottom friction + breaking: unified energy dissipation.
        // exp(-k*depth) is the natural scaling:
        //   deep water (kd >> 1): negligible
        //   shallow water: increasing friction
        //   on land (depth < 0): exp grows, very aggressive decay
        // Skip at max ocean depth — open ocean floor has no seabed interaction.
        const energyBeforeDissipation = energy;
        if (newDepth < wavelength) {
          const frictionDecay =
            BOTTOM_FRICTION_RATE * Math.exp(-k * newDepth) * normalizedStep;
          energy *= Math.exp(-frictionDecay);

          // Breaking: additional strong decay in very shallow water
          if (newDepth < breakingDepth) {
            energy *= Math.exp(-BREAKING_DECAY_RATE * normalizedStep);
          }
        }
        // Carry forward previous step's turbulence with phase-based decay,
        // then add new local dissipation
        const prevTurbulence = srcTurbulence[i];
        const carryOver =
          prevTurbulence * Math.exp(-TURBULENCE_DECAY_RATE * normalizedStep);
        const localTurbulence =
          (energyBeforeDissipation - energy) * TURBULENCE_SCALE;
        const turbulence = carryOver + localTurbulence;

        // Proximity-based blend: ramp from 0 at edges to 1 one wavelength in
        const distToLateralEdge = Math.min(perp - minPerp, maxPerp - perp);
        const distToDownwave = maxProj - proj;
        const distToUpwave = proj - minProj;
        const blend =
          Math.min(Math.min(distToLateralEdge, distToDownwave), distToUpwave) /
          wavelength;
        const clampedBlend = Math.max(0, Math.min(1, blend));

        // Split segment when energy contrast with previous ray is too extreme.
        // This prevents low-energy land rays from triangulating against healthy ocean rays.
        if (outEnergy.length > 0) {
          const prevEnergy = outEnergy[outEnergy.length - 1];
          const ratio =
            energy > prevEnergy ? energy / prevEnergy : prevEnergy / energy;
          if (ratio > MAX_ENERGY_RATIO) {
            flushCurrentSegment();
          }
        }

        outX.push(nx);
        outY.push(ny);
        outT.push(pt);
        outDirX.push(dirX);
        outDirY.push(dirY);
        outEnergy.push(energy);
        outTurbulence.push(turbulence);
        outDepth.push(Math.max(0, newDepth));
        outAmplitude.push(0);
        outBlend.push(clampedBlend);
      }

      if (outX.length > 0) {
        nextStep.push(
          refineWavefront(currentSegment, vertexSpacing, initialDeltaT, stats),
        );
      }
    }

    if (nextStep.length === 0) break;

    // Count rays in this step
    let stepRays = 0;
    for (const seg of nextStep) {
      stepRays += seg.x.length;
    }
    totalRaySteps += stepRays;
    stepCount++;

    // Time-based progress logging — report every 5s
    const now = performance.now();
    if (now >= nextProgressTime) {
      const elapsed = now - marchStartTime;
      const pct = Math.min(100, (stepCount / estimatedSteps) * 100);
      const raysPerSec = elapsed > 0 ? (totalRaySteps / elapsed) * 1000 : 0;
      const segments = nextStep.length;
      const fmt = (v: number) =>
        v.toLocaleString(undefined, { maximumFractionDigits: 0 });
      console.log(
        `  [march] step ${fmt(stepCount)}/${fmt(estimatedSteps)} (${pct.toFixed(0)}%) ` +
          `${(elapsed / 1000).toFixed(1)}s elapsed, ${fmt(totalRaySteps)} total ray steps, ` +
          `${fmt(stepRays)} rays (${segments} seg), ${fmt(raysPerSec)} rays/s`,
      );
      nextProgressTime = now + 5000;
    }

    postProcessStep(nextStep);
    wavefronts.push(nextStep);

    // Compact the second-to-last step — it's fully post-processed and no
    // longer needed as a marching source. The latest step (nextStep) must
    // keep its full data since it's the source for the next march iteration.
    if (wavefronts.length >= 3) {
      compactStep(wavefronts[wavefronts.length - 2], compactMs);
    }
  }

  // Compact the first step (initial wavefront) and the final step
  if (wavefronts.length >= 2) {
    compactStep(wavefronts[0], compactMs);
    compactStep(wavefronts[wavefronts.length - 1], compactMs);
  }

  return {
    wavefronts,
    splits: stats.splits,
    merges: stats.merges,
    amplitudeMs,
    diffractionMs,
    compactMs: compactMs.value,
    turnClampCount,
    totalRefractions,
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
        // Sentinel rays at domain edges always have amplitude 1.0
        if (t[i] === 0 || t[i] === 1) {
          amplitude[i] = 1.0;
          continue;
        }

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
