import type {
  MarchingWavefrontSegment,
  Wavefront,
  WavefrontSegment,
} from "./marchingTypes";

const CHECK_INVARIANTS = process.env.NODE_ENV !== "production";

export function hasMarchingFields(
  segment: WavefrontSegment,
): segment is MarchingWavefrontSegment {
  if (
    !("dirX" in segment) ||
    !("dirY" in segment) ||
    !("energy" in segment) ||
    !("depth" in segment)
  ) {
    return false;
  }
  const len = segment.t.length;
  return (
    segment.dirX.length === len &&
    segment.dirY.length === len &&
    segment.energy.length === len &&
    segment.depth.length === len
  );
}

export function assertSegmentAlignedLengths(
  segment: WavefrontSegment,
  context: string,
): void {
  if (!CHECK_INVARIANTS) return;
  const len = segment.t.length;
  const requiredFields: Array<[string, { length: number }]> = [
    ["x", segment.x],
    ["y", segment.y],
    ["turbulence", segment.turbulence],
    ["amplitude", segment.amplitude],
    ["blend", segment.blend],
  ];

  for (const [field, arr] of requiredFields) {
    if (arr.length !== len) {
      throw new Error(
        `[wavefront] ${context}: ${field}.length=${arr.length} does not match t.length=${len}`,
      );
    }
  }

  if (hasMarchingFields(segment)) {
    const marchingFields: Array<[string, { length: number }]> = [
      ["dirX", segment.dirX],
      ["dirY", segment.dirY],
      ["energy", segment.energy],
      ["depth", segment.depth],
    ];
    for (const [field, arr] of marchingFields) {
      if (arr.length !== len) {
        throw new Error(
          `[wavefront] ${context}: ${field}.length=${arr.length} does not match t.length=${len}`,
        );
      }
    }
  }
}

export function assertSegmentMonotonicT(
  segment: WavefrontSegment,
  context: string,
): void {
  if (!CHECK_INVARIANTS) return;
  const t = segment.t;
  for (let i = 1; i < t.length; i++) {
    if (t[i] < t[i - 1]) {
      throw new Error(
        `[wavefront] ${context}: non-monotonic t at index ${i - 1} -> ${i}`,
      );
    }
  }
}

export function assertWavefrontInvariants(
  wavefront: Wavefront,
  context: string,
): void {
  if (!CHECK_INVARIANTS) return;
  for (let i = 0; i < wavefront.length; i++) {
    const segment = wavefront[i];
    const segContext = `${context} segment=${i}`;
    assertSegmentAlignedLengths(segment, segContext);
    assertSegmentMonotonicT(segment, segContext);
  }
}
