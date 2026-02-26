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
  MarchingWavefront,
  MarchingWavefrontSegment,
  WaveBounds,
  Wavefront,
  WavefrontSegment,
} from "./marchingTypes";
import type { MeshBuildConfig } from "./meshBuildConfig";
import { DEFAULT_MESH_BUILD_CONFIG } from "./meshBuildConfig";
import type { TerrainHeightGradient } from "./terrainHeightCPU";
import {
  advanceInteriorRay,
  advanceSentinelRay,
} from "./rayStepPhysics";
import {
  applyDiffraction,
  computeAmplitudes,
  diffuseTurbulenceStep,
} from "./wavefrontPost";
import {
  createEmptySegment,
  refineWavefront,
  resetRefineWarnings,
} from "./wavefrontRefine";
import { assertWavefrontInvariants } from "./wavefrontContracts";
import type { SegmentTrack } from "./segmentTracks";
import { decimateTrackSnapshots } from "./decimateWavefrontTracks";

interface ActiveTrackState {
  trackId: number;
  parentTrackId: number | null;
  segment: MarchingWavefrontSegment;
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
  wavelength: number,
): WavefrontSegment {
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const wavefrontWidth = bounds.maxPerp - bounds.minPerp;

  // Interior rays span the domain; sentinels extend beyond
  const numInterior = Math.max(
    3,
    Math.ceil(wavefrontWidth / vertexSpacing) + 1,
  );
  // +2 for sentinel rays on each side
  const numVertices = numInterior + 2;

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

  // Left sentinel at minPerp
  const leftPerpPos = bounds.minPerp;
  x[0] = bounds.minProj * waveDx + leftPerpPos * perpDx;
  y[0] = bounds.minProj * waveDy + leftPerpPos * perpDy;
  t[0] = 0;
  dirX[0] = waveDx;
  dirY[0] = waveDy;
  energy[0] = 1.0;
  turbulence[0] = 0;
  depth[0] = wavelength;
  amplitude[0] = 0;
  blend[0] = 1.0;

  // Interior rays
  for (let i = 0; i < numInterior; i++) {
    const idx = i + 1;
    // Map interior rays to t in (0, 1) exclusive — sentinels own t=0 and t=1
    const ti = (i + 1) / (numInterior + 1);
    const perpPos = bounds.minPerp + (i / (numInterior - 1)) * wavefrontWidth;
    x[idx] = bounds.minProj * waveDx + perpPos * perpDx;
    y[idx] = bounds.minProj * waveDy + perpPos * perpDy;
    t[idx] = ti;
    dirX[idx] = waveDx;
    dirY[idx] = waveDy;
    energy[idx] = 1.0;
    turbulence[idx] = 0;
    depth[idx] = 0;
    amplitude[idx] = 0;
    blend[idx] = 1.0;
  }

  // Right sentinel at maxPerp
  const rightPerpPos = bounds.maxPerp;
  const last = numVertices - 1;
  x[last] = bounds.minProj * waveDx + rightPerpPos * perpDx;
  y[last] = bounds.minProj * waveDy + rightPerpPos * perpDy;
  t[last] = 1;
  dirX[last] = waveDx;
  dirY[last] = waveDy;
  energy[last] = 1.0;
  turbulence[last] = 0;
  depth[last] = wavelength;
  amplitude[last] = 0;
  blend[last] = 1.0;

  return {
    trackId: 0,
    parentTrackId: null,
    sourceStepIndex: 0,
    x,
    y,
    t,
    dirX,
    dirY,
    energy,
    turbulence,
    depth,
    amplitude,
    blend,
  };
}


/**
 * Compact a fully post-processed wavefront step to reduce memory.
 * 1. Converts the 5 mesh-output fields (x, y, t, amplitude, turbulence)
 *    from number[] to Float32Array (halves per-element storage)
 * 2. Replaces the 4 marching-only fields (dirX, dirY, energy, depth) with
 *    empty arrays, so compacted steps no longer carry marching payload data.
 *
 * This reduces per-step memory by ~78% (5/9 fields kept × 4/8 bytes each).
 * Full vertex decimation is deferred to the post-march pass.
 */
function compactStep(step: Wavefront, compactMs: { value: number }): void {
  const t0 = performance.now();
  for (let i = 0; i < step.length; i++) {
    const segment = step[i];
    const marchingSegment = segment as MarchingWavefrontSegment;

    // Compact in place so all snapshot references observe reduced payload.
    segment.x = new Float32Array(segment.x);
    segment.y = new Float32Array(segment.y);
    segment.t = new Float32Array(segment.t);
    segment.turbulence = new Float32Array(segment.turbulence);
    segment.amplitude = new Float32Array(segment.amplitude);
    segment.blend = new Float32Array(segment.blend);
    marchingSegment.dirX = [];
    marchingSegment.dirY = [];
    marchingSegment.energy = [];
    marchingSegment.depth = [];
  }
  compactMs.value += performance.now() - t0;
}

/**
 * March wavefronts step-by-step until all rays leave the domain or die.
 * Each ray advances independently, turning via Snell's law based on the
 * local depth gradient. Amplitude and diffraction are applied step-by-step
 * as new steps are produced.
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
  config: MeshBuildConfig = DEFAULT_MESH_BUILD_CONFIG,
  options?: { includeWavefronts?: boolean },
): {
  tracks: SegmentTrack[];
  wavefronts?: Wavefront[];
  marchedVerticesBeforeDecimation: number;
  removedSegmentSnapshots: number;
  removedVertices: number;
  splits: number;
  merges: number;
  amplitudeMs: number;
  diffractionMs: number;
  compactMs: number;
  turnClampCount: number;
  totalRefractions: number;
} {
  resetRefineWarnings();
  const perpDx = -waveDy;
  const perpDy = waveDx;
  const includeWavefronts = options?.includeWavefronts ?? false;
  const wavefronts: Wavefront[] = includeWavefronts ? [[firstWavefront]] : [];
  let nextTrackId = firstWavefront.trackId + 1;
  const workQueue: ActiveTrackState[] = [
    {
      trackId: firstWavefront.trackId,
      parentTrackId: firstWavefront.parentTrackId,
      segment: firstWavefront as MarchingWavefrontSegment,
    },
  ];
  const trackMap = new Map<number, SegmentTrack>();
  trackMap.set(firstWavefront.trackId, {
    trackId: firstWavefront.trackId,
    parentTrackId: firstWavefront.parentTrackId,
    childTrackIds: [],
    snapshots: [
      {
        stepIndex: 0,
        segmentIndex: 0,
        sourceStepIndex: firstWavefront.sourceStepIndex,
        segment: firstWavefront,
      },
    ],
  });
  const k = (2 * Math.PI) / wavelength;
  const terrainGradientSample: TerrainHeightGradient = {
    height: 0,
    gradientX: 0,
    gradientY: 0,
  };
  const stats = { splits: 0, merges: 0 };
  let turnClampCount = 0;
  let totalRefractions = 0;
  let marchedVerticesBeforeDecimation = firstWavefront.t.length;
  let removedSegmentSnapshots = 0;
  let removedVertices = 0;
  // Use t-spacing between interior rays (skip sentinel at index 0).
  // Interior rays start at index 1; their spacing is t[2]-t[1].
  const initialDeltaT =
    firstWavefront.t.length > 2
      ? firstWavefront.t[2] - firstWavefront.t[1]
      : firstWavefront.t.length > 1
        ? firstWavefront.t[1] - firstWavefront.t[0]
        : 1;
  const singleStep: MarchingWavefront[] = [];
  let amplitudeMs = 0;
  let diffractionMs = 0;
  const compactMs = { value: 0 };

  const minProj = bounds.minProj;
  const maxProj = bounds.maxProj;
  const minPerp = bounds.minPerp;
  const maxPerp = bounds.maxPerp;
  const breakingDepth = config.physics.breakingDepthRatio * wavelength;

  const postProcessStep = (step: MarchingWavefront): void => {
    assertWavefrontInvariants(step, "marchWavefronts postProcess input");
    singleStep[0] = step;
    const tA = performance.now();
    computeAmplitudes(
      singleStep,
      wavelength,
      vertexSpacing,
      initialDeltaT,
      config.post,
    );
    const tB = performance.now();
    applyDiffraction(
      singleStep,
      wavelength,
      vertexSpacing,
      stepSize,
      initialDeltaT,
      config.post,
    );
    diffuseTurbulenceStep(step, config.post);
    const tC = performance.now();
    assertWavefrontInvariants(step, "marchWavefronts postProcess output");
    amplitudeMs += tB - tA;
    diffractionMs += tC - tB;
  };

  // Progress logging — use time-based interval so first report comes quickly
  const estimatedSteps = Math.ceil(
    (bounds.maxProj - bounds.minProj) / stepSize,
  );
  let furthestStepIndex = 0;
  let marchedStepCount = 0;
  let marchStartTime = performance.now();
  let nextProgressTime = marchStartTime + 2000; // first report after 2s
  let totalRaySteps = 0;
  const phasePerStep = k * stepSize;

  // Keep boundary-row behavior consistent with full-pass post-processing.
  postProcessStep([firstWavefront as MarchingWavefrontSegment]);

  const finalizeTrack = (trackId: number): void => {
    const trackState = trackMap.get(trackId);
    if (!trackState) return;
    const decimated = decimateTrackSnapshots(
      trackState,
      wavelength,
      waveDx,
      waveDy,
      config.decimation.tolerance,
      phasePerStep,
    );
    removedSegmentSnapshots += decimated.removedSegmentSnapshots;
    removedVertices += decimated.removedVertices;
    trackMap.set(trackId, decimated.track);
  };

  while (workQueue.length > 0) {
    const track = workQueue.shift();
    if (!track) break;

    let segment = track.segment;
    for (;;) {
      const nextSourceStepIndex = segment.sourceStepIndex + 1;
      const srcX = segment.x;
      const srcY = segment.y;
      const srcT = segment.t;
      const srcDirX = segment.dirX;
      const srcDirY = segment.dirY;
      const srcEnergy = segment.energy;
      const srcTurbulence = segment.turbulence;
      const srcLen = srcX.length;

      const producedSegments: MarchingWavefront = [];
      let currentSegment = createEmptySegment(
        -1,
        track.trackId,
        nextSourceStepIndex,
      );
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
        producedSegments.push(
          refineWavefront(
            currentSegment,
            vertexSpacing,
            initialDeltaT,
            stats,
            config.refinement,
          ),
        );
        currentSegment = createEmptySegment(
          -1,
          track.trackId,
          nextSourceStepIndex,
        );
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
        if (!isSentinel && startEnergy < config.refinement.minEnergy) {
          flushCurrentSegment();
          continue;
        }

        if (isSentinel) {
          const sentinel = advanceSentinelRay(
            px,
            py,
            waveDx,
            waveDy,
            stepSize,
            minProj,
            maxProj,
          );
          if (!sentinel) {
            flushCurrentSegment();
            continue;
          }

          outX.push(sentinel.nx);
          outY.push(sentinel.ny);
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

        const interior = advanceInteriorRay({
          px,
          py,
          startEnergy,
          prevTurbulence: srcTurbulence[i],
          baseDirX: srcDirX[i],
          baseDirY: srcDirY[i],
          waveDx,
          waveDy,
          perpDx,
          perpDy,
          minProj,
          maxProj,
          minPerp,
          maxPerp,
          stepSize,
          wavelength,
          k,
          breakingDepth,
          physics: config.physics,
          terrain,
          terrainGradientSample,
        });
        if (!interior) {
          flushCurrentSegment();
          continue;
        }

        if (interior.refracted) {
          totalRefractions++;
        }
        if (interior.turnClamped) {
          turnClampCount++;
        }

        // Split segment when energy contrast with previous ray is too extreme.
        // This prevents low-energy land rays from triangulating against healthy ocean rays.
        if (outEnergy.length > 0) {
          const prevEnergy = outEnergy[outEnergy.length - 1];
          const ratio =
            interior.energy > prevEnergy
              ? interior.energy / prevEnergy
              : prevEnergy / interior.energy;
          if (ratio > config.refinement.maxEnergyRatio) {
            flushCurrentSegment();
          }
        }

        outX.push(interior.nx);
        outY.push(interior.ny);
        outT.push(pt);
        outDirX.push(interior.dirX);
        outDirY.push(interior.dirY);
        outEnergy.push(interior.energy);
        outTurbulence.push(interior.turbulence);
        outDepth.push(interior.depth);
        outAmplitude.push(0);
        outBlend.push(1.0);
      }

      if (outX.length > 0) {
        producedSegments.push(
          refineWavefront(
            currentSegment,
            vertexSpacing,
            initialDeltaT,
            stats,
            config.refinement,
          ),
        );
      }

      if (producedSegments.length === 0) {
        compactStep([segment], compactMs);
        finalizeTrack(track.trackId);
        break;
      }

      if (producedSegments.length === 1) {
        producedSegments[0].trackId = track.trackId;
        producedSegments[0].parentTrackId = track.parentTrackId;
      } else {
        const parent = trackMap.get(track.trackId);
        for (const child of producedSegments) {
          child.trackId = nextTrackId++;
          child.parentTrackId = track.trackId;
          parent?.childTrackIds.push(child.trackId);
        }
      }

      assertWavefrontInvariants(producedSegments, "marchWavefronts nextStep");
      postProcessStep(producedSegments);
      if (includeWavefronts) {
        wavefronts.push(producedSegments);
      }

      // Count rays in this step
      let stepRays = 0;
      for (const seg of producedSegments) {
        stepRays += seg.x.length;
      }
      totalRaySteps += stepRays;
      marchedStepCount++;
      furthestStepIndex = Math.max(furthestStepIndex, nextSourceStepIndex);

      // Time-based progress logging — report every 5s
      const now = performance.now();
      if (now >= nextProgressTime) {
        const elapsed = now - marchStartTime;
        const pct = Math.min(100, (furthestStepIndex / estimatedSteps) * 100);
        const raysPerSec = elapsed > 0 ? (totalRaySteps / elapsed) * 1000 : 0;
        const segments = producedSegments.length;
        const fmt = (v: number) =>
          v.toLocaleString(undefined, { maximumFractionDigits: 0 });
        console.log(
          `  [march] step ${fmt(furthestStepIndex)}/${fmt(estimatedSteps)} (${pct.toFixed(0)}%) ` +
            `${(elapsed / 1000).toFixed(1)}s elapsed, ${fmt(totalRaySteps)} total ray steps, ` +
            `${fmt(stepRays)} rays (${segments} seg), ${fmt(raysPerSec)} rays/s`,
        );
        nextProgressTime = now + 5000;
      }

      if (producedSegments.length === 1) {
        const nextSegment = producedSegments[0];
        const trackState = trackMap.get(track.trackId);
        if (!trackState) {
          throw new Error(
            `[marchWavefronts] missing track ${track.trackId} while appending step`,
          );
        }
        trackState.snapshots.push({
          stepIndex: nextSourceStepIndex,
          segmentIndex: 0,
          sourceStepIndex: nextSegment.sourceStepIndex,
          segment: nextSegment,
        });
        marchedVerticesBeforeDecimation += nextSegment.t.length;

        compactStep([segment], compactMs);
        segment = nextSegment;
        continue;
      }

      for (let childIdx = 0; childIdx < producedSegments.length; childIdx++) {
        const child = producedSegments[childIdx];
        trackMap.set(child.trackId, {
          trackId: child.trackId,
          parentTrackId: child.parentTrackId,
          childTrackIds: [],
          snapshots: [
            {
              stepIndex: nextSourceStepIndex,
              segmentIndex: childIdx,
              sourceStepIndex: child.sourceStepIndex,
              segment: child,
            },
          ],
        });
        marchedVerticesBeforeDecimation += child.t.length;
        workQueue.push({
          trackId: child.trackId,
          parentTrackId: child.parentTrackId,
          segment: child,
        });
      }

      compactStep([segment], compactMs);
      finalizeTrack(track.trackId);
      break;
    }
  }

  const tracks = Array.from(trackMap.values()).sort((a, b) => a.trackId - b.trackId);
  for (const track of tracks) {
    track.childTrackIds = Array.from(new Set(track.childTrackIds)).sort(
      (a, b) => a - b,
    );
    track.snapshots.sort((a, b) => {
      if (a.sourceStepIndex !== b.sourceStepIndex) {
        return a.sourceStepIndex - b.sourceStepIndex;
      }
      return a.segmentIndex - b.segmentIndex;
    });
  }

  return {
    tracks,
    wavefronts: includeWavefronts ? wavefronts : undefined,
    marchedVerticesBeforeDecimation,
    removedSegmentSnapshots,
    removedVertices,
    splits: stats.splits,
    merges: stats.merges,
    amplitudeMs,
    diffractionMs,
    compactMs: compactMs.value,
    turnClampCount,
    totalRefractions,
  };
}
