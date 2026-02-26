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

interface AdvanceTrackSegmentStepResult {
  nextSourceStepIndex: number;
  producedSegments: MarchingWavefront;
  refractedCount: number;
  turnClampedCount: number;
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
  const terrainGradX = new Array<number>(numVertices);
  const terrainGradY = new Array<number>(numVertices);
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
  terrainGradX[0] = 0;
  terrainGradY[0] = 0;
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
    // Force one terrain sample on each interior ray's first step.
    terrainGradX[idx] = Number.NaN;
    terrainGradY[idx] = Number.NaN;
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
  terrainGradX[last] = 0;
  terrainGradY[last] = 0;
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
    terrainGradX,
    terrainGradY,
    amplitude,
    blend,
  };
}


/**
 * Compact a fully post-processed wavefront step to reduce memory.
 * 1. Converts the 5 mesh-output fields (x, y, t, amplitude, turbulence)
 *    from number[] to Float32Array (halves per-element storage)
 * 2. Replaces marching-only fields (dirX, dirY, energy, depth, terrainGradX, terrainGradY) with
 *    empty arrays, so compacted steps no longer carry marching payload data.
 *
 * This reduces per-step memory by ~78% (5/9 fields kept × 4/8 bytes each).
 * Full vertex decimation is deferred to the post-march pass.
 */
export function compactStep(step: Wavefront, compactMs: { value: number }): void {
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
    marchingSegment.terrainGradX = [];
    marchingSegment.terrainGradY = [];
  }
  compactMs.value += performance.now() - t0;
}

export function advanceTrackSegmentStep(params: {
  track: ActiveTrackState;
  segment: MarchingWavefrontSegment;
  waveDx: number;
  waveDy: number;
  perpDx: number;
  perpDy: number;
  stepSize: number;
  vertexSpacing: number;
  minProj: number;
  maxProj: number;
  minPerp: number;
  maxPerp: number;
  wavelength: number;
  k: number;
  breakingDepth: number;
  initialDeltaT: number;
  terrain: TerrainCPUData;
  terrainGradientSample: TerrainHeightGradient;
  config: MeshBuildConfig;
  stats: { splits: number; merges: number };
}): AdvanceTrackSegmentStepResult {
  const {
    track,
    segment,
    waveDx,
    waveDy,
    perpDx,
    perpDy,
    stepSize,
    vertexSpacing,
    minProj,
    maxProj,
    minPerp,
    maxPerp,
    wavelength,
    k,
    breakingDepth,
    initialDeltaT,
    terrain,
    terrainGradientSample,
    config,
    stats,
  } = params;
  const nextSourceStepIndex = segment.sourceStepIndex + 1;
  const srcX = segment.x;
  const srcY = segment.y;
  const srcT = segment.t;
  const srcDirX = segment.dirX;
  const srcDirY = segment.dirY;
  const srcEnergy = segment.energy;
  const srcTurbulence = segment.turbulence;
  const srcDepth = segment.depth;
  const srcTerrainGradX = segment.terrainGradX;
  const srcTerrainGradY = segment.terrainGradY;
  const srcLen = srcX.length;

  const producedSegments: MarchingWavefront = [];
  let refractedCount = 0;
  let turnClampedCount = 0;

  let currentSegment = createEmptySegment(-1, track.trackId, nextSourceStepIndex);
  let outX = currentSegment.x;
  let outY = currentSegment.y;
  let outT = currentSegment.t;
  let outDirX = currentSegment.dirX;
  let outDirY = currentSegment.dirY;
  let outEnergy = currentSegment.energy;
  let outTurbulence = currentSegment.turbulence;
  let outDepth = currentSegment.depth;
  let outTerrainGradX = currentSegment.terrainGradX;
  let outTerrainGradY = currentSegment.terrainGradY;
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
    currentSegment = createEmptySegment(-1, track.trackId, nextSourceStepIndex);
    outX = currentSegment.x;
    outY = currentSegment.y;
    outT = currentSegment.t;
    outDirX = currentSegment.dirX;
    outDirY = currentSegment.dirY;
    outEnergy = currentSegment.energy;
    outTurbulence = currentSegment.turbulence;
    outDepth = currentSegment.depth;
    outTerrainGradX = currentSegment.terrainGradX;
    outTerrainGradY = currentSegment.terrainGradY;
    outAmplitude = currentSegment.amplitude;
    outBlend = currentSegment.blend;
  };

  for (let i = 0; i < srcLen; i++) {
    const startEnergy = srcEnergy[i];
    const px = srcX[i];
    const py = srcY[i];
    const pt = srcT[i];
    const isSentinel = pt === 0 || pt === 1;

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
      outTerrainGradX.push(0);
      outTerrainGradY.push(0);
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
      currentDepth: srcDepth[i],
      currentGradientX: srcTerrainGradX[i],
      currentGradientY: srcTerrainGradY[i],
    });
    if (!interior) {
      flushCurrentSegment();
      continue;
    }

    if (interior.refracted) {
      refractedCount++;
    }
    if (interior.turnClamped) {
      turnClampedCount++;
    }

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
    outTerrainGradX.push(interior.terrainGradX);
    outTerrainGradY.push(interior.terrainGradY);
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

  return {
    nextSourceStepIndex,
    producedSegments,
    refractedCount,
    turnClampedCount,
  };
}

/**
 * March wavefronts step-by-step until all rays leave the domain or die.
 * Each ray advances independently, turning via Snell's law based on the
 * local depth gradient. Amplitude and diffraction are applied step-by-step
 * as new steps are produced.
 */
export async function marchWavefronts(
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

  // Progress logging for track-queued marching.
  // `furthestStepIndex` is depth reached along any track, while
  // `marchedStepCount` is total processed track steps across all branches.
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

  const requestedWorkersRaw = process.env.MESH_BUILD_WORKERS;
  const requestedWorkers =
    requestedWorkersRaw === undefined
      ? null
      : Number.parseInt(requestedWorkersRaw, 10);
  const canUseWorkers =
    !includeWavefronts && process.release?.name === "node";

  if (canUseWorkers) {
    marchedVerticesBeforeDecimation = 0;
    const [{ Worker }, { cpus }, { fileURLToPath }, path] = await Promise.all([
      import("node:worker_threads"),
      import("node:os"),
      import("node:url"),
      import("node:path"),
    ]);
    const availableCores = cpus().length;
    const desiredWorkers =
      requestedWorkers === null || !Number.isFinite(requestedWorkers)
        ? availableCores
        : requestedWorkers;
    const workerCount = Math.max(1, Math.min(desiredWorkers, availableCores));
    console.log(
      `[marching] workers ${workerCount}/${availableCores} (MESH_BUILD_WORKERS=${requestedWorkersRaw ?? "auto"})`,
    );
    if (workerCount <= 1) {
      // Fall back to in-process execution when no parallelism is possible.
      marchedVerticesBeforeDecimation = firstWavefront.t.length;
    } else {
    const WORKER_EXEC_ARGV = ["--require", "tsx/cjs"];
    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "marchTrackWorker.ts",
    );

    const toShared = (buffer: ArrayBufferLike, byteOffset = 0, byteLength?: number) => {
      const len = byteLength ?? buffer.byteLength;
      const shared = new SharedArrayBuffer(len);
      new Uint8Array(shared).set(new Uint8Array(buffer, byteOffset, len));
      return shared;
    };

    const vertexDataBuffer = toShared(
      terrain.vertexData.buffer,
      terrain.vertexData.byteOffset,
      terrain.vertexData.byteLength,
    );
    const contourDataBuffer = toShared(terrain.contourData);
    const childrenDataBuffer = toShared(
      terrain.childrenData.buffer,
      terrain.childrenData.byteOffset,
      terrain.childrenData.byteLength,
    );

    const workers = Array.from({ length: workerCount }, () => {
      return new Worker(workerPath, {
        execArgv: WORKER_EXEC_ARGV,
        workerData: {
          vertexDataBuffer,
          contourDataBuffer,
          childrenDataBuffer,
          contourCount: terrain.contourCount,
          defaultDepth: terrain.defaultDepth,
          waveDx,
          waveDy,
          stepSize,
          vertexSpacing,
          bounds: { minProj, maxProj, minPerp, maxPerp },
          wavelength,
          config,
          initialDeltaT,
          phasePerStep,
        },
      });
    });

    type TrackJob = {
      trackId: number;
      parentTrackId: number | null;
      initialSegmentIndex: number;
      seedSegment: MarchingWavefrontSegment;
    };

    type TrackJobResult = {
      type: "trackResult";
      jobId: number;
      track: SegmentTrack;
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
      furthestStepIndex: number;
      marchedStepCount: number;
      totalRaySteps: number;
    };
    type TrackChildrenNotice = {
      type: "trackChildren";
      jobId: number;
      parentTrackId: number;
      childSeeds: Array<{ segmentIndex: number; segment: MarchingWavefrontSegment }>;
    };

    const trackJobs: TrackJob[] = [
      {
        trackId: firstWavefront.trackId,
        parentTrackId: firstWavefront.parentTrackId,
        initialSegmentIndex: 0,
        seedSegment: firstWavefront as MarchingWavefrontSegment,
      },
    ];
    trackMap.clear();

    let nextJobId = 1;
    const idleWorkerIds = workers.map((_, i) => i);
    const inFlight: Array<{
      workerId: number;
      promise: Promise<TrackJobResult>;
      job: TrackJob;
    }> = [];
    const childTrackIdsByParent = new Map<number, number[]>();
    let completedJobs = 0;
    let totalSpawnedChildren = 0;
    let maxQueueLength = trackJobs.length;
    let maxActiveWorkers = 0;
    let queueSamples = 0;
    let queueSampleSum = 0;
    let activeSamples = 0;
    let activeSampleSum = 0;
    let maxJobMs = 0;
    let minJobMs = Number.POSITIVE_INFINITY;
    let totalJobMs = 0;
    const inFlightStartedAt = new Map<number, number>();

    const handleChildSeeds = (
      parentTrackId: number,
      childSeeds: Array<{ segmentIndex: number; segment: MarchingWavefrontSegment }>,
    ): void => {
      const childTrackIds: number[] = [];
      for (const childSeed of childSeeds) {
        const childTrackId = nextTrackId++;
        childTrackIds.push(childTrackId);
        childSeed.segment.trackId = childTrackId;
        childSeed.segment.parentTrackId = parentTrackId;
        trackJobs.push({
          trackId: childTrackId,
          parentTrackId,
          initialSegmentIndex: childSeed.segmentIndex,
          seedSegment: childSeed.segment,
        });
      }
      childTrackIdsByParent.set(parentTrackId, childTrackIds);
      totalSpawnedChildren += childTrackIds.length;
    };

    const runJob = (workerId: number, job: TrackJob): Promise<TrackJobResult> => {
      const worker = workers[workerId];
      return new Promise((resolve, reject) => {
        const onMessage = (msg: TrackJobResult | TrackChildrenNotice) => {
          if (msg.type === "trackChildren") {
            handleChildSeeds(msg.parentTrackId, msg.childSeeds);
            return;
          }
          worker.off("error", onError);
          worker.off("message", onMessage);
          resolve(msg);
        };
        const onError = (err: Error) => {
          worker.off("message", onMessage);
          reject(err);
        };
        worker.on("message", onMessage);
        worker.once("error", onError);
        worker.postMessage({
          type: "runTrack",
          jobId: nextJobId++,
          trackId: job.trackId,
          parentTrackId: job.parentTrackId,
          initialSegmentIndex: job.initialSegmentIndex,
          seedSegment: job.seedSegment,
        });
      });
    };

    try {
      while (trackJobs.length > 0 || inFlight.length > 0) {
        maxQueueLength = Math.max(maxQueueLength, trackJobs.length);
        maxActiveWorkers = Math.max(maxActiveWorkers, inFlight.length);
        queueSamples++;
        queueSampleSum += trackJobs.length;
        activeSamples++;
        activeSampleSum += inFlight.length;

        while (idleWorkerIds.length > 0 && trackJobs.length > 0) {
          const workerId = idleWorkerIds.pop();
          const job = trackJobs.shift();
          if (workerId === undefined || !job) break;
          inFlightStartedAt.set(job.trackId, performance.now());
          inFlight.push({
            workerId,
            promise: runJob(workerId, job),
            job,
          });
        }

        if (inFlight.length === 0) break;

        const raced = await Promise.race(
          inFlight.map((entry, idx) =>
            entry.promise.then((result) => ({ idx, result })),
          ),
        );
        const finished = inFlight.splice(raced.idx, 1)[0];
        idleWorkerIds.push(finished.workerId);
        const result = raced.result;
        const startedAt = inFlightStartedAt.get(finished.job.trackId);
        if (startedAt !== undefined) {
          inFlightStartedAt.delete(finished.job.trackId);
          const jobMs = performance.now() - startedAt;
          totalJobMs += jobMs;
          maxJobMs = Math.max(maxJobMs, jobMs);
          minJobMs = Math.min(minJobMs, jobMs);
        }
        completedJobs++;

        marchedVerticesBeforeDecimation += result.marchedVerticesBeforeDecimation;
        removedSegmentSnapshots += result.removedSegmentSnapshots;
        removedVertices += result.removedVertices;
        stats.splits += result.splits;
        stats.merges += result.merges;
        amplitudeMs += result.amplitudeMs;
        diffractionMs += result.diffractionMs;
        compactMs.value += result.compactMs;
        turnClampCount += result.turnClampCount;
        totalRefractions += result.totalRefractions;
        furthestStepIndex = Math.max(furthestStepIndex, result.furthestStepIndex);
        marchedStepCount += result.marchedStepCount;
        totalRaySteps += result.totalRaySteps;

        const parentTrack = result.track;
        parentTrack.childTrackIds =
          childTrackIdsByParent.get(parentTrack.trackId) ?? [];
        childTrackIdsByParent.delete(parentTrack.trackId);
        trackMap.set(parentTrack.trackId, parentTrack);

        const now = performance.now();
        if (now >= nextProgressTime) {
          const elapsed = now - marchStartTime;
          const depthPct = Math.min(100, (furthestStepIndex / estimatedSteps) * 100);
          const raysPerSec = elapsed > 0 ? (totalRaySteps / elapsed) * 1000 : 0;
          const avgQueue = queueSamples > 0 ? queueSampleSum / queueSamples : 0;
          const avgActive = activeSamples > 0 ? activeSampleSum / activeSamples : 0;
          const utilizationPct =
            workerCount > 0 ? (100 * avgActive) / workerCount : 0;
          const avgJobMs = completedJobs > 0 ? totalJobMs / completedJobs : 0;
          const fmt = (v: number) =>
            v.toLocaleString(undefined, { maximumFractionDigits: 0 });
          console.log(
            `  [march] depth ${fmt(furthestStepIndex)}/${fmt(estimatedSteps)} (${depthPct.toFixed(0)}%), ` +
              `processed ${fmt(marchedStepCount)} track-steps, queue ${fmt(trackJobs.length)} ` +
              `active ${fmt(inFlight.length)} | ${(elapsed / 1000).toFixed(1)}s elapsed, ` +
              `${fmt(totalRaySteps)} total ray steps, ${fmt(raysPerSec)} rays/s ` +
              `| util ${utilizationPct.toFixed(0)}% avgActive ${avgActive.toFixed(2)} ` +
              `avgQueue ${avgQueue.toFixed(2)} maxActive ${fmt(maxActiveWorkers)} maxQueue ${fmt(maxQueueLength)} ` +
              `jobs ${fmt(completedJobs)} children ${fmt(totalSpawnedChildren)} ` +
              `jobMs avg=${avgJobMs.toFixed(1)} min=${(Number.isFinite(minJobMs) ? minJobMs : 0).toFixed(1)} max=${maxJobMs.toFixed(1)}`,
          );
          nextProgressTime = now + 5000;
        }
      }
    } finally {
      await Promise.allSettled(workers.map((w) => w.terminate()));
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
      wavefronts: undefined,
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
  }

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
      const {
        nextSourceStepIndex,
        producedSegments,
        refractedCount,
        turnClampedCount: stepTurnClampedCount,
      } = advanceTrackSegmentStep({
        track,
        segment,
        waveDx,
        waveDy,
        perpDx,
        perpDy,
        stepSize,
        vertexSpacing,
        minProj,
        maxProj,
        minPerp,
        maxPerp,
        wavelength,
        k,
        breakingDepth,
        initialDeltaT,
        terrain,
        terrainGradientSample,
        config,
        stats,
      });
      totalRefractions += refractedCount;
      turnClampCount += stepTurnClampedCount;

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
        const depthPct = Math.min(100, (furthestStepIndex / estimatedSteps) * 100);
        const raysPerSec = elapsed > 0 ? (totalRaySteps / elapsed) * 1000 : 0;
        const segments = producedSegments.length;
        const fmt = (v: number) =>
          v.toLocaleString(undefined, { maximumFractionDigits: 0 });
        console.log(
          `  [march] depth ${fmt(furthestStepIndex)}/${fmt(estimatedSteps)} (${depthPct.toFixed(0)}%), ` +
            `processed ${fmt(marchedStepCount)} track-steps, queue ${fmt(workQueue.length)} ` +
            `| ${(elapsed / 1000).toFixed(1)}s elapsed, ${fmt(totalRaySteps)} total ray steps, ` +
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
