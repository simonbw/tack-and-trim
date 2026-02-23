/** Floats per output vertex: [x, y, amplitude, dirOffset, phaseOffset, blendWeight] */
export const VERTEX_FLOATS = 6;

/**
 * Struct-of-arrays layout for a contiguous wavefront segment.
 * All arrays must have identical length and shared index semantics.
 */
export interface WavefrontSegment {
  x: number[] | Float32Array;
  y: number[] | Float32Array;
  /** Parametric position along the wavefront [0..1], used for triangulation */
  t: number[] | Float32Array;
  /** Ray propagation direction (unit vector), updated each step via Snell's law */
  dirX: number[];
  dirY: number[];
  /** Surviving energy fraction [0, 1], only decreases (terrain attenuation, breaking) */
  energy: number[];
  /** Turbulent energy [0, 1] — instantaneous energy dissipated by breaking at this point */
  turbulence: number[] | Float32Array;
  /** Water depth at this point (max(0, -terrainHeight)), cached from marching */
  depth: number[];
  /** Final amplitude factor = energy * shoaling * divergence */
  amplitude: number[] | Float32Array;
}

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
  x: number[];
  y: number[];
  t: number[];
  dirX: number[];
  dirY: number[];
  energy: number[];
  turbulence: number[];
  depth: number[];
  amplitude: number[];
}

/** A wavefront step: one or more disconnected segments (split by dead rays) */
export type Wavefront = WavefrontSegment[];
