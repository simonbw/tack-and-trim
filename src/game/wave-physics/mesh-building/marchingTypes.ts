/** Floats per output vertex: [x, y, amplitude, dirOffset, phaseOffset, blendWeight] */
export const VERTEX_FLOATS = 6;

/**
 * Struct-of-arrays layout for a contiguous wavefront segment.
 * All arrays must have identical length and shared index semantics.
 */
export interface WavefrontSegment {
  x: number[];
  y: number[];
  /** Parametric position along the wavefront [0..1], used for triangulation */
  t: number[];
  /** Ray propagation direction (unit vector), updated each step via Snell's law */
  dirX: number[];
  dirY: number[];
  /** Surviving energy fraction [0, 1], only decreases (terrain attenuation, breaking) */
  energy: number[];
  /** Breaking intensity [0, 1] — ramps up as depth falls below breaking threshold, never decreases */
  broken: number[];
  /** Water depth at this point (max(0, -terrainHeight)), cached from marching */
  depth: number[];
  /** Final amplitude factor = energy * shoaling * divergence */
  amplitude: number[];
}

/** Bounding box aligned to the wave propagation direction */
export interface WaveBounds {
  minProj: number; // upwave edge
  maxProj: number; // downwave edge
  minPerp: number; // wave-left edge
  maxPerp: number; // wave-right edge
}

/** A wavefront step: one or more disconnected segments (split by dead rays) */
export type Wavefront = WavefrontSegment[];
