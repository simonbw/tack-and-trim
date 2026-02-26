import type { MeshBuildPostConfig } from "./meshBuildConfig";
import { DEFAULT_MESH_BUILD_CONFIG } from "./meshBuildConfig";
import type {
  MarchingWavefront,
  Wavefront,
  WavefrontSegment,
} from "./marchingTypes";

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
 * Lateral amplitude diffusion along a wavefront segment (diffraction).
 *
 * Boundary conditions:
 * - Domain edges (t ≈ 0 or t ≈ 1): open ocean, ghost amplitude = 1.0
 * - Shadow edges (segment broke due to dead rays): ghost amplitude = 0 (fade out)
 */
function diffuseSegment(
  segment: WavefrontSegment,
  D: number,
  iterations: number,
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

  for (let iter = 0; iter < iterations; iter++) {
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
  iterations: number,
  diffusionD: number,
  scratch: Float64Array<ArrayBufferLike>,
): Float64Array<ArrayBufferLike> {
  const turbulence = segment.turbulence;
  const n = turbulence.length;
  if (n <= 2) return scratch;

  let old = scratch;
  if (old.length < n) {
    old = new Float64Array(n);
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) old[i] = turbulence[i];

    for (let i = 0; i < n; i++) {
      const left = i > 0 ? old[i - 1] : 0;
      const right = i < n - 1 ? old[i + 1] : 0;
      turbulence[i] = Math.max(
        0,
        old[i] + diffusionD * (left - 2 * old[i] + right),
      );
    }
  }

  return old;
}

export function diffuseTurbulenceStep(
  step: Wavefront,
  config: MeshBuildPostConfig = DEFAULT_MESH_BUILD_CONFIG.post,
): void {
  let scratch: Float64Array<ArrayBufferLike> = new Float64Array(0);
  for (const segment of step) {
    scratch = diffuseTurbulenceSegment(
      segment,
      config.turbulenceDiffusionIterations,
      config.turbulenceDiffusionD,
      scratch,
    );
  }
}

/**
 * Post-march lateral diffusion of amplitude across wavefronts (diffraction).
 */
export function applyDiffraction(
  wavefronts: Wavefront[],
  wavelength: number,
  vertexSpacing: number,
  stepSize: number,
  initialDeltaT: number,
  config: MeshBuildPostConfig = DEFAULT_MESH_BUILD_CONFIG.post,
): void {
  const k = (2 * Math.PI) / wavelength;

  // D = Δs / (2k · Δn²) — longer wavelengths (smaller k) diffract more
  const D = Math.min(
    config.maxDiffusionD,
    stepSize / (2 * k * vertexSpacing ** 2),
  );
  let scratch: Float64Array<ArrayBufferLike> = new Float64Array(0);

  for (const step of wavefronts) {
    for (const segment of step) {
      scratch = diffuseSegment(
        segment,
        D,
        config.diffractionIterations,
        initialDeltaT,
        scratch,
      );
    }
  }
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
  wavefronts: MarchingWavefront[],
  wavelength: number,
  vertexSpacing: number,
  initialDeltaT: number,
  config: MeshBuildPostConfig = DEFAULT_MESH_BUILD_CONFIG.post,
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
            ? Math.min(computeShoalingFactor(pDepth, k), config.maxAmplification)
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
          config.maxAmplification,
          Math.sqrt(expectedSpacing / localSpacing),
        );

        amplitude[i] = energy[i] * shoaling * divergence;
      }
    }
  }
}
