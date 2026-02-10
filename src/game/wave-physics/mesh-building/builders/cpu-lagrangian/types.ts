/** Floats per output vertex: [x, y, amplitude, dirOffset, phaseOffset, blendWeight] */
export const VERTEX_FLOATS = 6;

export interface WavePoint {
  x: number;
  y: number;
  /** Parametric position along the wavefront [0..1], used for triangulation */
  t: number;
}

/** Bounding box aligned to the wave propagation direction */
export interface WaveBounds {
  minProj: number; // upwave edge
  maxProj: number; // downwave edge
  minPerp: number; // wave-left edge
  maxPerp: number; // wave-right edge
}
