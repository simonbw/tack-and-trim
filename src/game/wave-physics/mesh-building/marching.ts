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
 *    c. Rotates its direction via Snell's law: d\u03b8/ds = -(1/c) * \u2202c/\u2202n
 *       where \u2202c/\u2202n is the speed gradient perpendicular to the ray
 *    d. Advances by stepSize * speedFactor in its (updated) direction
 *
 *    Rays do NOT influence each other's direction. The wavefront is purely a
 *    bookkeeping structure for triangulation \u2014 not a physics input.
 *
 * 3. After each step, a refinement pass merges points that have bunched up
 *    (ray convergence near caustics) to keep the mesh well-conditioned.
 *
 * 4. Energy tracking: rays passing over terrain lose energy exponentially
 *    based on the terrain height above water. This is the only thing tracked
 *    during marching \u2014 amplitude is computed in a separate pass afterward.
 *
 * 5. Amplitude computation (separate pass after marching):
 *    amplitude = energy * shoaling * divergence
 *    - energy:     surviving fraction after terrain attenuation
 *    - shoaling:   depth-based amplification (waves get taller in shallow water)
 *    - divergence: ray spacing factor (energy spreads as rays diverge)
 */

import type { TerrainCPUData } from "../../world/terrain/TerrainCPUData";
import type { WaveBounds, Wavefront, WavePoint } from "./marchingTypes";
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
 * when their distance exceeds vertexSpacing \u00d7 BASE_SPLIT_RATIO.
 */
const BASE_SPLIT_RATIO = 1.75;

/**
 * Per-level escalation of the split threshold. Each split halves the t-gap
 * between rays, creating a new "split level". At level n, the threshold is
 * BASE_SPLIT_RATIO \u00d7 SPLIT_ESCALATION^n \u00d7 vertexSpacing. For example:
 *   level 0 (original rays): 1.5  \u00d7 vertexSpacing
 *   level 1 (first split):   2.25 \u00d7 vertexSpacing  (\u00d71.5)
 *   level 2 (second split):  3.38 \u00d7 vertexSpacing  (\u00d71.5)
 * This damps cascade splitting \u2014 deeper offspring need proportionally larger
 * gaps before they'll split again.
 */
const SPLIT_ESCALATION = 1.6;

/** Precomputed exponent: tScale^SPLIT_ESCALATION_EXP = SPLIT_ESCALATION^depth */
const SPLIT_ESCALATION_EXP = Math.log2(SPLIT_ESCALATION);

/** Upper bound on the effective split ratio for deeply-nested split offspring. */
const MAX_SPLIT_RATIO = 16.0;

/** Maximum number of midpoints to insert per segment per refinement pass */
const MAX_SPLITS_PER_SEGMENT = 100;

/** Hard cap on total points in a single segment \u2014 no splitting beyond this */
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

/** Normalized wave speed (c/c_deep) from water depth. Returns 0 for dry land. */
function normalizedSpeed(depth: number, k: number): number {
  if (depth <= 0) return 0;
  return Math.sqrt(Math.tanh(k * depth));
}

/**
 * Shoaling coefficient K_s for a given depth and wavenumber.
 * In shallow water waves slow down and get taller (K_s > 1).
 * In deep water K_s \u2248 1 (no effect).
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
): WavePoint[] {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefrontWidth = bounds.maxPerp - bounds.minPerp;

  const numVertices = Math.max(
    3,
    Math.ceil(wavefrontWidth / vertexSpacing) + 1,
  );
  const wavefront: WavePoint[] = [];
  for (let i = 0; i < numVertices; i++) {
    const t = i / (numVertices - 1);
    const perpPos = bounds.minPerp + t * wavefrontWidth;
    wavefront.push({
      x: bounds.minProj * waveDx + perpPos * perpDx,
      y: bounds.minProj * waveDy + perpPos * perpDy,
      t,
      dirX: waveDx,
      dirY: waveDy,
      energy: 1.0,
      broken: 0,
      depth: 0,
      amplitude: 0,
    });
  }
  return wavefront;
}

/**
 * Merge points that have bunched up and split points that have diverged,
 * in a single pass that builds a new array.
 */
function refineWavefront(
  wavefront: WavePoint[],
  vertexSpacing: number,
  initialDeltaT: number,
  stats: { splits: number; merges: number },
): WavePoint[] {
  if (wavefront.length <= 1) return wavefront;

  const minDistSq = (vertexSpacing * MERGE_RATIO) ** 2;
  const canSplit = wavefront.length < MAX_SEGMENT_POINTS;

  const result: WavePoint[] = [wavefront[0]];
  let splitCount = 0;

  for (let i = 1; i < wavefront.length; i++) {
    const prev = result[result.length - 1];
    const curr = wavefront[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const distSq = dx * dx + dy * dy;

    if (distSq < minDistSq) {
      // Too close \u2014 skip this point
      stats.merges++;
      continue;
    }

    // Split depth from t-gap: each split halves deltaT, so depth = log2(tScale).
    // Threshold escalates by SPLIT_ESCALATION per depth level.
    const deltaT = Math.abs(curr.t - prev.t);
    const tScale = deltaT > 1e-12 ? initialDeltaT / deltaT : MAX_SPLIT_RATIO;
    const escalation = Math.pow(tScale, SPLIT_ESCALATION_EXP);
    const effectiveRatio = Math.min(
      MAX_SPLIT_RATIO,
      BASE_SPLIT_RATIO * escalation,
    );
    const maxDistSq = (vertexSpacing * effectiveRatio) ** 2;

    // Split: insert interpolated midpoint when gap is too large.
    // Skip if either endpoint has low energy \u2014 midpoints placed on dying rays
    // (e.g. over terrain) tend to diverge and cause runaway splitting.
    if (
      canSplit &&
      distSq > maxDistSq &&
      splitCount < MAX_SPLITS_PER_SEGMENT &&
      prev.energy >= MIN_SPLIT_ENERGY &&
      curr.energy >= MIN_SPLIT_ENERGY
    ) {
      // Average direction, then normalize
      let midDirX = prev.dirX + curr.dirX;
      let midDirY = prev.dirY + curr.dirY;
      const len = Math.sqrt(midDirX * midDirX + midDirY * midDirY);
      if (len > 0) {
        midDirX /= len;
        midDirY /= len;
      }

      result.push({
        x: (prev.x + curr.x) / 2,
        y: (prev.y + curr.y) / 2,
        t: (prev.t + curr.t) / 2,
        dirX: midDirX,
        dirY: midDirY,
        energy: (prev.energy + curr.energy) / 2,
        broken: Math.max(prev.broken, curr.broken),
        depth: (prev.depth + curr.depth) / 2,
        amplitude: 0,
      });
      splitCount++;
      stats.splits++;
    }

    result.push(curr);
  }

  if (!canSplit) {
    console.warn(
      `[marching] Segment has ${wavefront.length} points (max ${MAX_SEGMENT_POINTS}), splitting disabled.`,
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
 * - Domain edges (t \u2248 0 or t \u2248 1): open ocean, ghost amplitude = 1.0
 * - Shadow edges (segment broke due to dead rays): ghost amplitude = 0 (fade out)
 */
function diffuseSegment(
  segment: WavePoint[],
  D: number,
  initialDeltaT: number,
  scratch: Float64Array<ArrayBufferLike>,
): Float64Array<ArrayBufferLike> {
  const n = segment.length;
  if (n <= 1) return scratch;

  // Domain-edge detection: rays near t=0 or t=1 border open ocean
  const edgeThreshold = initialDeltaT * 0.5;
  const leftIsDomainEdge = segment[0].t < edgeThreshold;
  const rightIsDomainEdge = segment[n - 1].t > 1 - edgeThreshold;

  let old = scratch;
  if (old.length < n) {
    old = new Float64Array(n);
  }

  for (let iter = 0; iter < DIFFRACTION_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) old[i] = segment[i].amplitude;

    for (let i = 0; i < n; i++) {
      // Domain edges: open ocean (amplitude = 1.0)
      // Shadow edges: zero (amplitude fades out toward shadow)
      const left = i > 0 ? old[i - 1] : leftIsDomainEdge ? 1.0 : 0;
      const right = i < n - 1 ? old[i + 1] : rightIsDomainEdge ? 1.0 : 0;

      segment[i].amplitude = Math.max(
        0,
        old[i] + D * (left - 2 * old[i] + right),
      );
    }
  }

  return old;
}

/**
 * Post-march lateral diffusion of amplitude across wavefronts (diffraction).
 *
 * Runs after computeAmplitudes. At each wavefront step, amplitude is smoothed
 * laterally via the parabolic approximation: \u2202A/\u2202s = (1/2k) \u00b7 \u2202\u00b2A/\u2202n\u00b2.
 *
 * This must run post-march rather than during marching, because during marching
 * terrain attenuation acts as an energy sink \u2014 lateral diffusion would feed
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

  // D = \u0394s / (2k \u00b7 \u0394n\u00b2) \u2014 longer wavelengths (smaller k) diffract more
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
 * local depth gradient. Only energy (dissipative losses) is tracked here;
 * amplitude is computed in a separate pass afterward.
 */
export function marchWavefronts(
  firstWavefront: WavePoint[],
  waveDx: number,
  waveDy: number,
  stepSize: number,
  vertexSpacing: number,
  bounds: WaveBounds,
  terrain: TerrainCPUData,
  wavelength: number,
): { wavefronts: Wavefront[]; splits: number; merges: number } {
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
    firstWavefront.length > 1 ? firstWavefront[1].t - firstWavefront[0].t : 1;

  function advanceRay(point: WavePoint): WavePoint | null {
    // Stop marching from a dead ray \u2014 the previous point (with low energy)
    // was kept as the final vertex so the mesh fades out smoothly.
    if (point.energy < MIN_ENERGY) return null;

    // Water depth and local terrain gradient at current position
    const terrainH = computeTerrainHeightAndGradient(
      point.x,
      point.y,
      terrain,
      terrainGradientSample,
    ).height;
    const currentDepth = Math.max(0, -terrainH);
    const baseSpeed = normalizedSpeed(currentDepth, k);
    const currentSpeed = Math.max(MIN_SPEED_FACTOR, baseSpeed);
    const localStep = stepSize * currentSpeed;

    let dirX = point.dirX;
    let dirY = point.dirY;

    // Apply Snell's law refraction when underwater.
    // On terrain, skip \u2014 there's no meaningful depth gradient to refract from.
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

      // Snell's law: d\u03b8 = -(1/c) * \u2202c/\u2202n * ds
      const dTheta = Math.max(
        -MAX_TURN_PER_STEP,
        Math.min(MAX_TURN_PER_STEP, -(1 / currentSpeed) * dcPerp * localStep),
      );

      const cosD = Math.cos(dTheta);
      const sinD = Math.sin(dTheta);
      dirX = point.dirX * cosD - point.dirY * sinD;
      dirY = point.dirX * sinD + point.dirY * cosD;
    }

    // Advance along ray direction
    const nx = point.x + dirX * localStep;
    const ny = point.y + dirY * localStep;

    // Bounds check in wave-aligned coordinates
    const proj = nx * waveDx + ny * waveDy;
    const perp = nx * perpDx + ny * perpDy;
    if (
      proj < bounds.minProj ||
      proj > bounds.maxProj ||
      perp < bounds.minPerp ||
      perp > bounds.maxPerp
    )
      return null;

    // Update energy (dissipative losses only)
    const newTerrainH = computeTerrainHeight(nx, ny, terrain);
    const newDepth = -newTerrainH;
    const normalizedStep = localStep / wavelength;

    let energy = point.energy;
    let broken = point.broken;

    if (newDepth <= 0) {
      // Over terrain: exponential decay based on terrain height
      const terrainAboveWater = -newDepth;
      energy *= Math.exp(
        -terrainAboveWater * k * TERRAIN_DECAY_RATE * normalizedStep,
      );
    }

    // Breaking: ramps up as depth falls below threshold, never decreases
    const breakingDepth = BREAKING_DEPTH_RATIO * wavelength;
    if (newDepth > 0 && newDepth < breakingDepth) {
      broken = Math.max(broken, 1.0 - newDepth / breakingDepth);
    }

    // Broken waves continuously lose energy
    if (broken > 0) {
      energy *= Math.exp(-BREAKING_DECAY_RATE * normalizedStep);
    }

    return {
      x: nx,
      y: ny,
      t: point.t,
      dirX,
      dirY,
      energy,
      broken,
      depth: Math.max(0, newDepth),
      amplitude: 0,
    };
  }

  for (;;) {
    const prevStep = wavefronts[wavefronts.length - 1];
    const nextStep: Wavefront = [];

    for (const segment of prevStep) {
      let currentSegment: WavePoint[] = [];
      for (const point of segment) {
        const p = advanceRay(point);
        if (p) {
          currentSegment.push(p);
        } else if (currentSegment.length > 0) {
          nextStep.push(
            refineWavefront(
              currentSegment,
              vertexSpacing,
              initialDeltaT,
              stats,
            ),
          );
          currentSegment = [];
        }
      }
      if (currentSegment.length > 0) {
        nextStep.push(
          refineWavefront(currentSegment, vertexSpacing, initialDeltaT, stats),
        );
      }
    }

    if (nextStep.length === 0) break;
    wavefronts.push(nextStep);
  }

  return { wavefronts, splits: stats.splits, merges: stats.merges };
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
      for (let i = 0; i < wf.length; i++) {
        const p = wf[i];

        // Shoaling from local depth (cached during marching)
        const shoaling =
          p.depth > 0
            ? Math.min(computeShoalingFactor(p.depth, k), MAX_AMPLIFICATION)
            : 1.0;

        // Divergence from spacing between adjacent rays (within segment only).
        // Use the t-gap to compute expected initial spacing so that split
        // midpoints use the correct reference (half the original spacing).
        let localSpacing: number;
        let deltaT: number;
        if (wf.length <= 1) {
          localSpacing = vertexSpacing;
          deltaT = initialDeltaT;
        } else if (i === 0) {
          const next = wf[i + 1];
          localSpacing = Math.sqrt((p.x - next.x) ** 2 + (p.y - next.y) ** 2);
          deltaT = next.t - p.t;
        } else if (i === wf.length - 1) {
          const prev = wf[i - 1];
          localSpacing = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
          deltaT = p.t - prev.t;
        } else {
          const prev = wf[i - 1];
          const next = wf[i + 1];
          const dPrev = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
          const dNext = Math.sqrt((p.x - next.x) ** 2 + (p.y - next.y) ** 2);
          localSpacing = (dPrev + dNext) / 2;
          deltaT = (next.t - prev.t) / 2;
        }

        // Expected initial spacing for this t-gap
        const expectedSpacing = deltaT * spacingPerT;

        const divergence = Math.min(
          MAX_AMPLIFICATION,
          Math.sqrt(expectedSpacing / localSpacing),
        );

        p.amplitude = p.energy * shoaling * divergence;
      }
    }
  }
}
