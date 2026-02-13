/** Floats per output vertex: [x, y, amplitude, dirOffset, phaseOffset, blendWeight] */
export const VERTEX_FLOATS = 6;

export interface WavePoint {
  x: number;
  y: number;
  /** Parametric position along the wavefront [0..1], used for triangulation */
  t: number;
  /** Ray propagation direction (unit vector), updated each step via Snell's law */
  dirX: number;
  dirY: number;
  /** Surviving energy fraction [0, 1], only decreases (terrain attenuation, breaking) */
  energy: number;
  /** Breaking intensity [0, 1] — ramps up as depth falls below breaking threshold, never decreases */
  broken: number;
  /** Final amplitude factor = energy * shoaling, written to mesh vertices */
  amplitude: number;
}

/** Bounding box aligned to the wave propagation direction */
export interface WaveBounds {
  minProj: number; // upwave edge
  maxProj: number; // downwave edge
  minPerp: number; // wave-left edge
  maxPerp: number; // wave-right edge
}

/** A contiguous run of connected wave points */
export type WavefrontSegment = WavePoint[];

/** A wavefront step: one or more disconnected segments (split by dead rays) */
export type Wavefront = WavefrontSegment[];
