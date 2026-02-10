/**
 * Gerstner wave shader module.
 * Analytical wave calculation using Gerstner formulation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { const_MAX_WAVE_SOURCES } from "./wave-constants.wgsl";

/**
 * Gerstner wave calculation function.
 * Two-pass algorithm: first pass computes horizontal displacement,
 * second pass computes height and velocity at displaced position.
 *
 * Each wave gets its own energy factor from the energyFactors array,
 * which combines wavefront mesh terrain interaction.
 * Phase corrections allow wavefront mesh-based phase adjustments per wave.
 */
export const fn_calculateGerstnerWaves: ShaderModule = {
  dependencies: [const_MAX_WAVE_SOURCES],
  code: /*wgsl*/ `
    // Calculate Gerstner waves with per-wave energy factors
    // worldPos: world position (feet)
    // time: simulation time (seconds)
    // waveData: wave parameters (storage buffer, 8 floats per wave)
    // numWaves: number of waves
    // steepness: Gerstner steepness factor
    // energyFactors: per-wave energy multiplier (0.0 = blocked, 1.0 = full)
    // directionOffsets: per-wave direction offset in radians (from direction bending)
    // phaseCorrections: per-wave phase correction in radians (from wavefront mesh)
    // ampMod: amplitude modulation factor (from noise)
    // Returns vec4<f32>(height, dispX, dispY, dhdt)
    fn calculateGerstnerWaves(
      worldPos: vec2<f32>,
      time: f32,
      waveData: ptr<storage, array<f32>, read>,
      numWaves: i32,
      steepness: f32,
      energyFactors: array<f32, MAX_WAVE_SOURCES>,
      directionOffsets: array<f32, MAX_WAVE_SOURCES>,
      phaseCorrections: array<f32, MAX_WAVE_SOURCES>,
      ampMod: f32,
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
        let direction = waveData[base + 2];
        let phaseOffset = waveData[base + 3];
        let speedMult = waveData[base + 4];
        let sourceDist = waveData[base + 5];
        let sourceOffsetX = waveData[base + 6];
        let sourceOffsetY = waveData[base + 7];

        let k = TWO_PI / wavelength;
        let omega = sqrt(GRAVITY * k) * speedMult;

        var dx: f32;
        var dy: f32;
        var phase: f32;

        // Plane wave or point source?
        if (sourceDist > 1e9) {
          // Plane wave - apply direction offset for direction bending
          let bentDirection = direction + directionOffsets[i];
          dx = cos(bentDirection);
          dy = sin(bentDirection);
          let projected = x * dx + y * dy;
          phase = k * projected - omega * time + phaseOffset + phaseCorrections[i];
        } else {
          // Point source - direction from geometry, no offset
          let baseDx = cos(direction);
          let baseDy = sin(direction);
          let sourceX = -baseDx * sourceDist + sourceOffsetX;
          let sourceY = -baseDy * sourceDist + sourceOffsetY;

          let toPointX = x - sourceX;
          let toPointY = y - sourceY;
          let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

          dx = toPointX / distFromSource;
          dy = toPointY / distFromSource;
          phase = k * distFromSource - omega * time + phaseOffset + phaseCorrections[i];
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
        let direction = waveData[base + 2];
        let phaseOffset = waveData[base + 3];
        let speedMult = waveData[base + 4];
        let sourceDist = waveData[base + 5];
        let sourceOffsetX = waveData[base + 6];
        let sourceOffsetY = waveData[base + 7];

        // Apply per-wave energy factor
        amplitude *= energyFactors[i];

        let k = TWO_PI / wavelength;
        let omega = sqrt(GRAVITY * k) * speedMult;

        var phase: f32;

        if (sourceDist > 1e9) {
          // Plane wave - apply direction offset for direction bending
          let bentDirection = direction + directionOffsets[i];
          let bentDx = cos(bentDirection);
          let bentDy = sin(bentDirection);
          let projected = sampleX * bentDx + sampleY * bentDy;
          phase = k * projected - omega * time + phaseOffset + phaseCorrections[i];
        } else {
          // Point source - direction from geometry, no offset
          let baseDx = cos(direction);
          let baseDy = sin(direction);
          let sourceX = -baseDx * sourceDist + sourceOffsetX;
          let sourceY = -baseDy * sourceDist + sourceOffsetY;

          let toPointX = sampleX - sourceX;
          let toPointY = sampleY - sourceY;
          let distFromSource = sqrt(toPointX * toPointX + toPointY * toPointY);

          phase = k * distFromSource - omega * time + phaseOffset + phaseCorrections[i];
        }

        let sinPhase = sin(phase);
        let cosPhase = cos(phase);

        height += amplitude * ampMod * sinPhase;
        dhdt += -amplitude * ampMod * omega * cosPhase;
      }

      return vec4<f32>(height, dispX, dispY, dhdt);
    }
  `,
};
