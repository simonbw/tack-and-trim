import type { MeshBuildRefinementConfig } from "./meshBuildConfig";
import { DEFAULT_MESH_BUILD_CONFIG } from "./meshBuildConfig";
import type { MutableWavefrontSegment } from "./marchingTypes";

/** Throttle "splitting disabled" warning to once per build */
let warnedSplitDisabled = false;

export interface RefineStats {
  splits: number;
  merges: number;
}

export function resetRefineWarnings(): void {
  warnedSplitDisabled = false;
}

export function createEmptySegment(
  sourceStepIndex: number = 0,
): MutableWavefrontSegment {
  return {
    sourceStepIndex,
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

/**
 * Merge points that have bunched up and split points that have diverged,
 * in a single pass that builds a new segment.
 */
export function refineWavefront(
  wavefront: MutableWavefrontSegment,
  vertexSpacing: number,
  initialDeltaT: number,
  stats: RefineStats,
  config: MeshBuildRefinementConfig = DEFAULT_MESH_BUILD_CONFIG.refinement,
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

  const minDistSq = (vertexSpacing * config.mergeRatio) ** 2;
  const canSplit = srcLen < config.maxSegmentPoints;
  const splitEscalationExp = Math.log2(config.splitEscalation);

  const result = createEmptySegment(wavefront.sourceStepIndex);
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
    const tScale =
      deltaT > 1e-12 ? initialDeltaT / deltaT : config.maxSplitRatio;
    const escalation = Math.pow(tScale, splitEscalationExp);
    const effectiveRatio = Math.min(
      config.maxSplitRatio,
      config.baseSplitRatio * escalation,
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
      splitCount < config.maxSplitsPerSegment &&
      prevEnergy >= config.minSplitEnergy &&
      currEnergy >= config.minSplitEnergy &&
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
      `[marching] Segment has ${srcLen} points (max ${config.maxSegmentPoints}), splitting disabled.`,
    );
  } else if (splitCount >= config.maxSplitsPerSegment) {
    console.warn(
      `[marching] Split limit reached (${config.maxSplitsPerSegment} per segment). ` +
        `Rays may be diverging excessively.`,
    );
  }

  return result;
}
