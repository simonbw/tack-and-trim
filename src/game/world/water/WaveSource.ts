import { V2d } from "../../../core/Vector";

/**
 * Configuration for a single Gerstner wave source
 */
export interface WaveSourceConfig {
  /** Wave direction in radians (0 = east, π/2 = north) */
  direction: number;
  /** Wave amplitude in meters (half of wave height) */
  amplitude: number;
  /** Wavelength in meters (distance between crests) */
  wavelength: number;
}

/**
 * Represents a single Gerstner wave source with precomputed parameters.
 * Implements the Gerstner wave equations for realistic ocean waves.
 *
 * Math background:
 * - Wave number k = 2π / wavelength
 * - Angular frequency ω = sqrt(g * k) for deep water waves
 * - Phase φ = k * dot(position, direction) - ω * time
 * - Horizontal displacement = direction * (amplitude / k) * cos(φ)
 * - Vertical displacement = amplitude * sin(φ)
 * - Vertical velocity = -amplitude * ω * cos(φ)
 */
export class WaveSource {
  readonly direction: number;
  readonly directionVec: V2d;
  readonly baseAmplitude: number;
  readonly wavelength: number;
  readonly k: number; // Wave number (2π / wavelength)
  readonly omega: number; // Angular frequency

  /** Runtime-modifiable amplitude (can be changed without recreating source) */
  amplitude: number;

  constructor(config: WaveSourceConfig) {
    this.direction = config.direction;
    this.directionVec = new V2d(
      Math.cos(config.direction),
      Math.sin(config.direction),
    );
    this.baseAmplitude = config.amplitude;
    this.amplitude = config.amplitude;
    this.wavelength = config.wavelength;

    // Wave number: k = 2π / λ
    this.k = (2 * Math.PI) / config.wavelength;

    // Angular frequency for deep water: ω = sqrt(g * k)
    const g = 9.81; // m/s² (gravity)
    this.omega = Math.sqrt(g * this.k);
  }

  /**
   * Compute the horizontal displacement caused by this wave at a given position and time.
   * This is the key difference between Gerstner waves and simple sine waves - the water
   * particles move in elliptical paths, creating more realistic wave shapes.
   *
   * @param pos Position to evaluate (before displacement)
   * @param time Current simulation time in seconds
   * @returns Horizontal displacement vector
   */
  computeDisplacement(pos: V2d, time: number): V2d {
    const phase = this.k * pos.dot(this.directionVec) - this.omega * time;
    const displacementMagnitude = (this.amplitude / this.k) * Math.cos(phase);
    return this.directionVec.mul(displacementMagnitude);
  }

  /**
   * Evaluate wave height and vertical velocity at a given position and time.
   * This should be called at the displaced position for accurate Gerstner evaluation.
   *
   * @param pos Position to evaluate (should be displaced position for Gerstner)
   * @param time Current simulation time in seconds
   * @returns Object with z (height) and vz (vertical velocity)
   */
  evaluate(pos: V2d, time: number): { z: number; vz: number } {
    const phase = this.k * pos.dot(this.directionVec) - this.omega * time;

    return {
      z: this.amplitude * Math.sin(phase),
      vz: -this.amplitude * this.omega * Math.cos(phase),
    };
  }

  /**
   * Pack wave data into Float32Array for GPU upload.
   * Layout (8 floats, 32 bytes with padding):
   *   [0-1]: direction vector (vec2f)
   *   [2]: amplitude (f32)
   *   [3]: wave number k (f32)
   *   [4]: angular frequency omega (f32)
   *   [5-7]: padding (vec3f for alignment)
   */
  getGPUData(): Float32Array {
    return new Float32Array([
      this.directionVec.x,
      this.directionVec.y,
      this.amplitude,
      this.k,
      this.omega,
      0, // padding
      0, // padding
      0, // padding
    ]);
  }

  /**
   * Set the runtime amplitude (for dynamic wave modulation)
   */
  setAmplitude(amplitude: number): void {
    this.amplitude = amplitude;
  }

  /**
   * Reset amplitude to the base configuration value
   */
  resetAmplitude(): void {
    this.amplitude = this.baseAmplitude;
  }
}
