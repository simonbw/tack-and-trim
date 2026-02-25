import { DEFAULT_MESH_BUILD_CONFIG } from "./meshBuildConfig";
import type { WavefrontSegment } from "./marchingTypes";
import { hasMarchingFields } from "./wavefrontContracts";

/** Default decimation tolerance — controls the quality/density trade-off. */
export const DEFAULT_DECIMATION_TOLERANCE =
  DEFAULT_MESH_BUILD_CONFIG.decimation.tolerance;

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Check whether all vertices strictly between anchorIdx and endpointIdx in a
 * segment are well-approximated by linear interpolation between the anchor
 * and endpoint vertices (both kept).
 */
function canRemoveVerticesBetween(
  segment: WavefrontSegment,
  anchorIdx: number,
  endpointIdx: number,
  posTolSq: number,
  ampTol: number,
): boolean {
  const t = segment.t;
  const x = segment.x;
  const y = segment.y;
  const amplitude = segment.amplitude;
  const turbulence = segment.turbulence;
  const blend = segment.blend;

  const aT = t[anchorIdx];
  const bT = t[endpointIdx];
  const tSpan = bT - aT;

  const ax = x[anchorIdx];
  const ay = y[anchorIdx];
  const bx = x[endpointIdx];
  const by = y[endpointIdx];

  const aAmp = amplitude[anchorIdx];
  const bAmp = amplitude[endpointIdx];

  const aTurb = turbulence[anchorIdx];
  const bTurb = turbulence[endpointIdx];

  const aBlend = blend[anchorIdx];
  const bBlend = blend[endpointIdx];

  for (let i = anchorIdx + 1; i < endpointIdx; i++) {
    const f = tSpan > 0 ? (t[i] - aT) / tSpan : 0;

    const ix = lerpScalar(ax, bx, f);
    const iy = lerpScalar(ay, by, f);
    const dx = x[i] - ix;
    const dy = y[i] - iy;
    if (dx * dx + dy * dy > posTolSq) return false;

    const iAmp = lerpScalar(aAmp, bAmp, f);
    if (Math.abs(amplitude[i] - iAmp) > ampTol) return false;

    const iTurb = lerpScalar(aTurb, bTurb, f);
    if (Math.abs(turbulence[i] - iTurb) > ampTol) return false;

    const iBlend = lerpScalar(aBlend, bBlend, f);
    if (Math.abs(blend[i] - iBlend) > ampTol) return false;
  }

  return true;
}

function copyKeptIndices(
  source: number[] | Float32Array,
  kept: number[],
  out: number[],
): void {
  for (let i = 0; i < kept.length; i++) {
    out[i] = source[kept[i]];
  }
}

function buildSegmentFromKept(
  segment: WavefrontSegment,
  kept: number[],
): WavefrontSegment {
  const n = kept.length;

  const outX = new Array<number>(n);
  const outY = new Array<number>(n);
  const outT = new Array<number>(n);
  const outTurbulence = new Array<number>(n);
  const outAmplitude = new Array<number>(n);
  const outBlend = new Array<number>(n);

  copyKeptIndices(segment.x, kept, outX);
  copyKeptIndices(segment.y, kept, outY);
  copyKeptIndices(segment.t, kept, outT);
  copyKeptIndices(segment.turbulence, kept, outTurbulence);
  copyKeptIndices(segment.amplitude, kept, outAmplitude);
  copyKeptIndices(segment.blend, kept, outBlend);

  if (hasMarchingFields(segment)) {
    const outDirX = new Array<number>(n);
    const outDirY = new Array<number>(n);
    const outEnergy = new Array<number>(n);
    const outDepth = new Array<number>(n);
    copyKeptIndices(segment.dirX, kept, outDirX);
    copyKeptIndices(segment.dirY, kept, outDirY);
    copyKeptIndices(segment.energy, kept, outEnergy);
    copyKeptIndices(segment.depth, kept, outDepth);
    return {
      sourceStepIndex: segment.sourceStepIndex,
      x: outX,
      y: outY,
      t: outT,
      dirX: outDirX,
      dirY: outDirY,
      energy: outEnergy,
      turbulence: outTurbulence,
      depth: outDepth,
      amplitude: outAmplitude,
      blend: outBlend,
    };
  }

  return {
    sourceStepIndex: segment.sourceStepIndex,
    x: outX,
    y: outY,
    t: outT,
    turbulence: outTurbulence,
    amplitude: outAmplitude,
    blend: outBlend,
  };
}

/**
 * Remove redundant interior vertices from a single segment.
 * First and last vertices are always kept.
 */
export function decimateSegment(
  segment: WavefrontSegment,
  posTolSq: number,
  ampTol: number,
): WavefrontSegment {
  const len = segment.t.length;
  if (len <= 2) return segment;

  const kept: number[] = [0];
  let anchor = 0;
  let endpoint = 2;

  while (endpoint <= len - 1) {
    const removable = canRemoveVerticesBetween(
      segment,
      anchor,
      endpoint,
      posTolSq,
      ampTol,
    );

    if (removable) {
      if (endpoint === len - 1) {
        kept.push(endpoint);
        break;
      }
      endpoint++;
    } else {
      kept.push(endpoint - 1);
      anchor = endpoint - 1;
      endpoint = anchor + 2;
    }
  }

  if (kept[kept.length - 1] !== len - 1) {
    kept.push(len - 1);
  }

  if (kept.length === len) return segment;
  return buildSegmentFromKept(segment, kept);
}
