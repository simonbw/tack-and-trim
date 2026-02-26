import { parentPort, workerData } from "node:worker_threads";
import type { TerrainCPUData } from "../../game/world/terrain/TerrainCPUData";
import type { MeshBuildConfig } from "./meshBuildConfig";
import type { TerrainHeightGradient } from "./terrainHeightCPU";
import type { MarchingWavefront, MarchingWavefrontSegment } from "./marchingTypes";
import type { SegmentTrack } from "./segmentTracks";
import { advanceTrackSegmentStep, compactStep } from "./marching";
import { decimateTrackSnapshots } from "./decimateWavefrontTracks";
import { applyDiffraction, computeAmplitudes, diffuseTurbulenceStep } from "./wavefrontPost";
import { assertWavefrontInvariants } from "./wavefrontContracts";

interface WorkerInitData {
  vertexDataBuffer: SharedArrayBuffer;
  contourDataBuffer: SharedArrayBuffer;
  childrenDataBuffer: SharedArrayBuffer;
  contourCount: number;
  defaultDepth: number;
  waveDx: number;
  waveDy: number;
  stepSize: number;
  vertexSpacing: number;
  bounds: { minProj: number; maxProj: number; minPerp: number; maxPerp: number };
  wavelength: number;
  config: MeshBuildConfig;
  initialDeltaT: number;
  phasePerStep: number;
}

interface TrackJobRequest {
  type: "runTrack";
  jobId: number;
  trackId: number;
  parentTrackId: number | null;
  initialSegmentIndex: number;
  seedSegment: MarchingWavefrontSegment;
}

interface ExitRequest {
  type: "exit";
}

type WorkerRequest = TrackJobRequest | ExitRequest;

interface ChildSeed {
  segmentIndex: number;
  segment: MarchingWavefrontSegment;
}

interface TrackJobResult {
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
}

interface TrackChildrenNotice {
  type: "trackChildren";
  jobId: number;
  parentTrackId: number;
  childSeeds: ChildSeed[];
}

const init = workerData as WorkerInitData;
const terrain: TerrainCPUData = {
  vertexData: new Float32Array(init.vertexDataBuffer),
  contourData: init.contourDataBuffer,
  childrenData: new Uint32Array(init.childrenDataBuffer),
  contourCount: init.contourCount,
  defaultDepth: init.defaultDepth,
};

function runTrackJob(req: TrackJobRequest): TrackJobResult {
  const stats = { splits: 0, merges: 0 };
  let turnClampCount = 0;
  let totalRefractions = 0;
  let marchedVerticesBeforeDecimation = req.seedSegment.t.length;
  let amplitudeMs = 0;
  let diffractionMs = 0;
  const compactMs = { value: 0 };
  let furthestStepIndex = req.seedSegment.sourceStepIndex;
  let marchedStepCount = 0;
  let totalRaySteps = 0;

  const singleStep: MarchingWavefront[] = [];
  const k = (2 * Math.PI) / init.wavelength;
  const perpDx = -init.waveDy;
  const perpDy = init.waveDx;
  const breakingDepth = init.config.physics.breakingDepthRatio * init.wavelength;
  const terrainGradientSample: TerrainHeightGradient = {
    height: 0,
    gradientX: 0,
    gradientY: 0,
  };

  const postProcessStep = (step: MarchingWavefront): void => {
    assertWavefrontInvariants(step, "marchTrackWorker postProcess input");
    singleStep[0] = step;
    const tA = performance.now();
    computeAmplitudes(
      singleStep,
      init.wavelength,
      init.vertexSpacing,
      init.initialDeltaT,
      init.config.post,
    );
    const tB = performance.now();
    applyDiffraction(
      singleStep,
      init.wavelength,
      init.vertexSpacing,
      init.stepSize,
      init.initialDeltaT,
      init.config.post,
    );
    diffuseTurbulenceStep(step, init.config.post);
    const tC = performance.now();
    amplitudeMs += tB - tA;
    diffractionMs += tC - tB;
    assertWavefrontInvariants(step, "marchTrackWorker postProcess output");
  };

  const track: SegmentTrack = {
    trackId: req.trackId,
    parentTrackId: req.parentTrackId,
    childTrackIds: [],
    snapshots: [
      {
        stepIndex: req.seedSegment.sourceStepIndex,
        segmentIndex: req.initialSegmentIndex,
        sourceStepIndex: req.seedSegment.sourceStepIndex,
        segment: req.seedSegment,
      },
    ],
  };

  let segment = req.seedSegment;
  let childSeedsSent = false;
  for (;;) {
    const {
      nextSourceStepIndex,
      producedSegments,
      refractedCount,
      turnClampedCount,
    } = advanceTrackSegmentStep({
      track: {
        trackId: req.trackId,
        parentTrackId: req.parentTrackId,
        segment,
      },
      segment,
      waveDx: init.waveDx,
      waveDy: init.waveDy,
      perpDx,
      perpDy,
      stepSize: init.stepSize,
      vertexSpacing: init.vertexSpacing,
      minProj: init.bounds.minProj,
      maxProj: init.bounds.maxProj,
      minPerp: init.bounds.minPerp,
      maxPerp: init.bounds.maxPerp,
      wavelength: init.wavelength,
      k,
      breakingDepth,
      initialDeltaT: init.initialDeltaT,
      terrain,
      terrainGradientSample,
      config: init.config,
      stats,
    });
    totalRefractions += refractedCount;
    turnClampCount += turnClampedCount;

    if (producedSegments.length === 0) {
      compactStep([segment], compactMs);
      break;
    }

    if (producedSegments.length === 1) {
      const nextSegment = producedSegments[0];
      nextSegment.trackId = req.trackId;
      nextSegment.parentTrackId = req.parentTrackId;
      assertWavefrontInvariants([nextSegment], "marchTrackWorker next single");
      postProcessStep([nextSegment]);
      track.snapshots.push({
        stepIndex: nextSourceStepIndex,
        segmentIndex: 0,
        sourceStepIndex: nextSegment.sourceStepIndex,
        segment: nextSegment,
      });
      marchedVerticesBeforeDecimation += nextSegment.t.length;
      furthestStepIndex = Math.max(furthestStepIndex, nextSourceStepIndex);
      marchedStepCount++;
      totalRaySteps += nextSegment.x.length;
      compactStep([segment], compactMs);
      segment = nextSegment;
      continue;
    }

    const childSeeds: ChildSeed[] = [];
    for (let i = 0; i < producedSegments.length; i++) {
      const child = producedSegments[i];
      child.trackId = req.trackId;
      child.parentTrackId = req.trackId;
      postProcessStep([child]);
      childSeeds.push({ segmentIndex: i, segment: child });
      marchedVerticesBeforeDecimation += child.t.length;
      totalRaySteps += child.x.length;
    }
    if (!childSeedsSent) {
      const childrenMsg: TrackChildrenNotice = {
        type: "trackChildren",
        jobId: req.jobId,
        parentTrackId: req.trackId,
        childSeeds,
      };
      parentPort?.postMessage(childrenMsg);
      childSeedsSent = true;
    }
    furthestStepIndex = Math.max(furthestStepIndex, nextSourceStepIndex);
    marchedStepCount++;
    compactStep([segment], compactMs);
    break;
  }

  const decimated = decimateTrackSnapshots(
    track,
    init.wavelength,
    init.waveDx,
    init.waveDy,
    init.config.decimation.tolerance,
    init.phasePerStep,
  );

  return {
    type: "trackResult",
    jobId: req.jobId,
    track: decimated.track,
    marchedVerticesBeforeDecimation,
    removedSegmentSnapshots: decimated.removedSegmentSnapshots,
    removedVertices: decimated.removedVertices,
    splits: stats.splits,
    merges: stats.merges,
    amplitudeMs,
    diffractionMs,
    compactMs: compactMs.value,
    turnClampCount,
    totalRefractions,
    furthestStepIndex,
    marchedStepCount,
    totalRaySteps,
  };
}

parentPort?.on("message", (msg: WorkerRequest) => {
  if (msg.type === "exit") {
    process.exit(0);
  }
  if (msg.type === "runTrack") {
    const result = runTrackJob(msg);
    parentPort?.postMessage(result);
  }
});
