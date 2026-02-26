/** Floats per output vertex: [x, y, amplitude, turbulence, phaseOffset, blendWeight] */
export const VERTEX_FLOATS = 6;

export type SegmentArray = number[] | Float32Array;

/**
 * Fields needed by downstream output stages (decimation, triangulation, serialization).
 */
export interface OutputWavefrontSegment {
  /** Stable lineage id for this segment track across march steps. */
  trackId: number;
  /** Parent track when this track was born from a split, otherwise null. */
  parentTrackId: number | null;
  /** Source march step index this segment snapshot came from. */
  sourceStepIndex: number;
  x: SegmentArray;
  y: SegmentArray;
  /** Parametric position along the wavefront [0..1], used for triangulation */
  t: SegmentArray;
  /** Turbulent energy [0, 1] — instantaneous energy dissipated by breaking at this point */
  turbulence: SegmentArray;
  /** Final amplitude factor = energy * shoaling * divergence */
  amplitude: SegmentArray;
  /** Blend weight [0..1] for boundary fading — 0 at mesh edges, 1 in interior */
  blend: SegmentArray;
}

/**
 * Struct-of-arrays layout for a contiguous wavefront segment.
 * All arrays must have identical length and shared index semantics.
 */
export interface MarchingWavefrontSegment extends OutputWavefrontSegment {
  /** Ray propagation direction (unit vector), updated each step via Snell's law */
  dirX: number[];
  dirY: number[];
  /** Surviving energy fraction [0, 1], only decreases (terrain attenuation, breaking) */
  energy: number[];
  /** Water depth at this point (max(0, -terrainHeight)), cached from marching */
  depth: number[];
}

export type WavefrontSegment = MarchingWavefrontSegment | OutputWavefrontSegment;

/** Bounding box aligned to the wave propagation direction */
export interface WaveBounds {
  minProj: number; // upwave edge
  maxProj: number; // downwave edge
  minPerp: number; // wave-left edge
  maxPerp: number; // wave-right edge
}

/**
 * A segment where all fields are mutable number[] — used during marching
 * when we need .push() on every field. Assignable to WavefrontSegment.
 */
export interface MutableWavefrontSegment {
  trackId: number;
  parentTrackId: number | null;
  sourceStepIndex: number;
  x: number[];
  y: number[];
  t: number[];
  dirX: number[];
  dirY: number[];
  energy: number[];
  turbulence: number[];
  depth: number[];
  amplitude: number[];
  blend: number[];
}

/** A wavefront step: one or more disconnected segments (split by dead rays) */
export type Wavefront<T extends WavefrontSegment = WavefrontSegment> = T[];

/** Wavefront step while marching state is still present. */
export type MarchingWavefront = Wavefront<MarchingWavefrontSegment>;

/** Wavefront step containing output-only fields. */
export type OutputWavefront = Wavefront<OutputWavefrontSegment>;
