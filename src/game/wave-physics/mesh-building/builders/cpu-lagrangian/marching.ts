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

import type { TerrainDataForWorker } from "../../MeshBuildTypes";
import { computeTerrainHeight } from "../../../cpu/terrainHeight";
import type { Wavefront, WaveBounds, WavePoint } from "./types";

/** Energy fraction below which a point is considered dead */
const MIN_ENERGY = 0.01;

/** Rate of energy decay when wave passes over terrain */
const TERRAIN_DECAY_RATE = 1.0;

/** Merge points closer than this fraction of vertex spacing */
const MERGE_RATIO = 0.3;

/** Maximum angular change per step (radians), prevents wild rotation */
const MAX_TURN_PER_STEP = Math.PI / 4;

/** Minimum march speed as fraction of deep water speed */
const MIN_SPEED_FACTOR = 0.25;

/** Maximum amplification from any single factor (shoaling or convergence) */
const MAX_AMPLIFICATION = 2.0;

/** Waves break when depth falls below this fraction of wavelength */
const BREAKING_DEPTH_RATIO = 0.07;

/** Energy decay rate per normalized step once a wave has broken */
const BREAKING_DECAY_RATE = 2.0;

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
      broken: false,
      amplitude: 0,
    });
  }
  return wavefront;
}

/**
 * Merge points that have bunched up, in a single pass that builds a new array.
 */
function refineWavefront(
  wavefront: WavePoint[],
  vertexSpacing: number,
): WavePoint[] {
  if (wavefront.length <= 1) return wavefront;

  const minDistSq = (vertexSpacing * MERGE_RATIO) ** 2;

  const result: WavePoint[] = [wavefront[0]];

  for (let i = 1; i < wavefront.length; i++) {
    const prev = result[result.length - 1];
    const curr = wavefront[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const distSq = dx * dx + dy * dy;

    if (distSq < minDistSq) {
      // Too close — skip this point
      continue;
    }

    // TODO: splitting (insert interpolated points when gap > maxDist)

    result.push(curr);
  }

  return result;
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
  terrain: TerrainDataForWorker,
  wavelength: number,
): Wavefront[] {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefronts: Wavefront[] = [[firstWavefront]];
  const k = (2 * Math.PI) / wavelength;
  const gradientDelta = wavelength * 0.125;

  function advanceRay(point: WavePoint): WavePoint | null {
    // Water depth and march speed at current position
    const terrainH = computeTerrainHeight(point.x, point.y, terrain);
    const currentDepth = Math.max(0, -terrainH);
    const currentSpeed = Math.max(
      MIN_SPEED_FACTOR,
      normalizedSpeed(currentDepth, k),
    );
    const localStep = stepSize * currentSpeed;

    let dirX = point.dirX;
    let dirY = point.dirY;

    // Apply Snell's law refraction when underwater.
    // On terrain, skip — there's no meaningful depth gradient to refract from.
    if (currentDepth > 0) {
      // Speed gradient via central finite differences
      const sRight = normalizedSpeed(
        Math.max(
          0,
          -computeTerrainHeight(point.x + gradientDelta, point.y, terrain),
        ),
        k,
      );
      const sLeft = normalizedSpeed(
        Math.max(
          0,
          -computeTerrainHeight(point.x - gradientDelta, point.y, terrain),
        ),
        k,
      );
      const sUp = normalizedSpeed(
        Math.max(
          0,
          -computeTerrainHeight(point.x, point.y + gradientDelta, terrain),
        ),
        k,
      );
      const sDown = normalizedSpeed(
        Math.max(
          0,
          -computeTerrainHeight(point.x, point.y - gradientDelta, terrain),
        ),
        k,
      );

      const dcdx = (sRight - sLeft) / (2 * gradientDelta);
      const dcdy = (sUp - sDown) / (2 * gradientDelta);

      // Component of speed gradient perpendicular to ray direction
      const dcPerp = -dcdx * dirY + dcdy * dirX;

      // Snell's law: dθ = -(1/c) * ∂c/∂n * ds
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

    // Breaking: triggered in shallow water, sticky once set
    if (
      !broken &&
      newDepth > 0 &&
      newDepth < BREAKING_DEPTH_RATIO * wavelength
    ) {
      broken = true;
    }

    // Broken waves continuously lose energy
    if (broken) {
      energy *= Math.exp(-BREAKING_DECAY_RATE * normalizedStep);
    }

    if (energy < MIN_ENERGY) return null;

    return {
      x: nx,
      y: ny,
      t: point.t,
      dirX,
      dirY,
      energy,
      broken,
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
          nextStep.push(refineWavefront(currentSegment, vertexSpacing));
          currentSegment = [];
        }
      }
      if (currentSegment.length > 0) {
        nextStep.push(refineWavefront(currentSegment, vertexSpacing));
      }
    }

    if (nextStep.length === 0) break;
    wavefronts.push(nextStep);
  }

  return wavefronts;
}

/**
 * Compute amplitude for every point in the wavefronts.
 * Combines three independent factors:
 * - energy:     surviving fraction after dissipative losses (from marching)
 * - shoaling:   depth-based amplification (waves get taller in shallow water)
 * - divergence: sqrt(initialSpacing / currentSpacing), energy spreads as rays
 *               diverge and concentrates as they converge
 */
export function computeAmplitudes(
  wavefronts: Wavefront[],
  terrain: TerrainDataForWorker,
  wavelength: number,
  vertexSpacing: number,
): void {
  const k = (2 * Math.PI) / wavelength;

  for (const step of wavefronts) {
    for (const wf of step) {
      for (let i = 0; i < wf.length; i++) {
        const p = wf[i];

        // Shoaling from local depth
        const terrainH = computeTerrainHeight(p.x, p.y, terrain);
        const depth = Math.max(0, -terrainH);
        const shoaling =
          depth > 0
            ? Math.min(computeShoalingFactor(depth, k), MAX_AMPLIFICATION)
            : 1.0;

        // Divergence from spacing between adjacent rays (within segment only)
        let localSpacing: number;
        if (wf.length <= 1) {
          localSpacing = vertexSpacing;
        } else if (i === 0) {
          const next = wf[i + 1];
          localSpacing = Math.sqrt((p.x - next.x) ** 2 + (p.y - next.y) ** 2);
        } else if (i === wf.length - 1) {
          const prev = wf[i - 1];
          localSpacing = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
        } else {
          const prev = wf[i - 1];
          const next = wf[i + 1];
          const dPrev = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
          const dNext = Math.sqrt((p.x - next.x) ** 2 + (p.y - next.y) ** 2);
          localSpacing = (dPrev + dNext) / 2;
        }

        const divergence = Math.min(
          MAX_AMPLIFICATION,
          Math.sqrt(vertexSpacing / localSpacing),
        );

        p.amplitude = p.energy * shoaling * divergence;
      }
    }
  }
}
