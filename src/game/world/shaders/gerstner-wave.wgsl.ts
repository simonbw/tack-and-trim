/**
 * Gerstner wave shader module.
 * Analytical wave calculation using Gerstner formulation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { wavePhysicsConstantsModule } from "./wave-physics.wgsl";

/**
 * Wave modification structure.
 * Returned by wave modification functions (diffraction, etc.).
 */
export const waveModificationStructModule: ShaderModule = {
  code: /*wgsl*/ `
    // Wave modification result
    struct WaveModification {
      energyFactor: f32,      // Amplitude multiplier (0.0 = blocked, 1.0 = full energy)
      newDirection: vec2<f32>, // Modified wave direction (unit vector)
    }
  `,
};

/**
 * Gerstner wave calculation module.
 * Two-pass algorithm: first pass computes horizontal displacement,
 * second pass computes height and velocity at displaced position.
 */
export const gerstnerWaveModule: ShaderModule = {
  code: /*wgsl*/ `
    // Calculate Gerstner waves with modification support
    // worldPos: world position (feet)
    // time: simulation time (seconds)
    // waveData: wave parameters (storage buffer, 8 floats per wave)
    // numWaves: number of waves
    // swellWaveCount: number of swell waves (rest are chop)
    // steepness: Gerstner steepness factor
    // swellMod: modification for swell waves (energy, direction)
    // chopMod: modification for chop waves (energy, direction)
    // ampMod: amplitude modulation factor (from noise)
    // waveSourceDirection: base wave source direction (radians)
    // Returns vec4<f32>(height, dispX, dispY, dhdt)
    fn calculateGerstnerWaves(
      worldPos: vec2<f32>,
      time: f32,
      waveData: ptr<storage, array<f32>, read>,
      numWaves: i32,
      swellWaveCount: i32,
      steepness: f32,
      swellMod: WaveModification,
      chopMod: WaveModification,
      ampMod: f32,
      waveSourceDirection: f32
    ) -> vec4<f32> {
      let x = worldPos.x;
      let y = worldPos.y;

      // First pass: compute Gerstner horizontal displacement
      var dispX = 0.0;
      var dispY = 0.0;

      for (var i = 0; i < numWaves; i++) {
        let base = i * 8;
        let amplitude = waveData[base + 0];
        let wavelength = waveData[base + 1];
        var direction = waveData[base + 2];
        let phaseOffset = waveData[base + 3];
        let speedMult = waveData[base + 4];
        let sourceDist = waveData[base + 5];
        let sourceOffsetX = waveData[base + 6];
        let sourceOffsetY = waveData[base + 7];

        // Apply direction modification from diffraction
        var waveMod: WaveModification;
        if (i < swellWaveCount) {
          waveMod = swellMod;
        } else {
          waveMod = chopMod;
        }

        let modDir = waveMod.newDirection;
        let dirOffset = atan2(modDir.y, modDir.x) - waveSourceDirection;
        direction += dirOffset;

        let baseDx = cos(direction);
        let baseDy = sin(direction);
        let k = TWO_PI / wavelength;
        let omega = sqrt(GRAVITY * k) * speedMult;

        var dx: f32;
        var dy: f32;
        var phase: f32;

        // Plane wave or point source?
        if (sourceDist > 1e9) {
          // Plane wave
          dx = baseDx;
          dy = baseDy;
          let projected = x * dx + y * dy;
          phase = k * projected - omega * time + phaseOffset;
        } else {
          // Point source
          let sourceX = -baseDx * sourceDist + sourceOffsetX;
          let sourceY = -baseDy * sourceDist + sourceOffsetY;

          let toPointX = x - sourceX;
          let toPointY = y - sourceY;
          let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

          dx = toPointX / distFromSource;
          dy = toPointY / distFromSource;
          phase = k * distFromSource - omega * time + phaseOffset;
        }

        let Q = steepness / (k * amplitude * f32(numWaves));
        let cosPhase = cos(phase);
        dispX += Q * amplitude * dx * cosPhase;
        dispY += Q * amplitude * dy * cosPhase;
      }

      // Second pass: compute height and dh/dt at displaced position
      let sampleX = x - dispX;
      let sampleY = y - dispY;
      var height = 0.0;
      var dhdt = 0.0;

      for (var i = 0; i < numWaves; i++) {
        let base = i * 8;
        var amplitude = waveData[base + 0];
        let wavelength = waveData[base + 1];
        var direction = waveData[base + 2];
        let phaseOffset = waveData[base + 3];
        let speedMult = waveData[base + 4];
        let sourceDist = waveData[base + 5];
        let sourceOffsetX = waveData[base + 6];
        let sourceOffsetY = waveData[base + 7];

        // Apply wave modification (energy and direction)
        var waveMod: WaveModification;
        if (i < swellWaveCount) {
          waveMod = swellMod;
          amplitude *= waveMod.energyFactor;
        } else {
          waveMod = chopMod;
          amplitude *= waveMod.energyFactor;
        }

        let modDir = waveMod.newDirection;
        let dirOffset = atan2(modDir.y, modDir.x) - waveSourceDirection;
        direction += dirOffset;

        let baseDx = cos(direction);
        let baseDy = sin(direction);
        let k = TWO_PI / wavelength;
        let omega = sqrt(GRAVITY * k) * speedMult;

        var phase: f32;

        if (sourceDist > 1e9) {
          let projected = sampleX * baseDx + sampleY * baseDy;
          phase = k * projected - omega * time + phaseOffset;
        } else {
          let sourceX = -baseDx * sourceDist + sourceOffsetX;
          let sourceY = -baseDy * sourceDist + sourceOffsetY;

          let toPointX = sampleX - sourceX;
          let toPointY = sampleY - sourceY;
          let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

          phase = k * distFromSource - omega * time + phaseOffset;
        }

        let sinPhase = sin(phase);
        let cosPhase = cos(phase);

        height += amplitude * ampMod * sinPhase;
        dhdt += -amplitude * ampMod * omega * cosPhase;
      }

      return vec4<f32>(height, dispX, dispY, dhdt);
    }
  `,
  dependencies: [wavePhysicsConstantsModule, waveModificationStructModule],
};
