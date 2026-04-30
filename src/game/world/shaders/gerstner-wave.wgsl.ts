/**
 * Gerstner wave shader module.
 * Analytical wave calculation using Gerstner formulation.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { const_MAX_WAVE_SOURCES } from "./wave-constants.wgsl";

/**
 * Gerstner wave calculation function.
 *
 * Two-pass algorithm: first pass computes horizontal displacement, second
 * pass computes height, time-derivative, horizontal orbital velocity, and
 * the analytic surface gradient at the displaced sample point.
 *
 * The gradient (dhdx, dhdy) is the Lagrangian derivative ∂h/∂s — i.e. with
 * respect to the back-displaced sample point, not the world position. For
 * the small steepnesses in use this matches the Eulerian ∂h/∂x to within a
 * fraction of a percent and skips the chain-rule correction through ∂disp/∂x.
 * Returning it directly lets callers compute the surface normal without a
 * 3-tap finite difference (3× the wave evaluations).
 */
export const fn_calculateGerstnerWaves: ShaderModule = {
  dependencies: [const_MAX_WAVE_SOURCES],
  code: /*wgsl*/ `
    struct GerstnerWaveResult {
      height: f32,
      dhdx: f32,
      dhdy: f32,
      velX: f32,
      velY: f32,
      dhdt: f32,
    }

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
    ) -> GerstnerWaveResult {
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

      // Second pass: compute height, dh/dt, horizontal orbital velocity, and
      // analytic surface gradient at the displaced sample point.
      let sampleX = x - dispX;
      let sampleY = y - dispY;
      var height = 0.0;
      var dhdt = 0.0;
      var velX = 0.0;
      var velY = 0.0;
      var dhdx = 0.0;
      var dhdy = 0.0;

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
        var propDx: f32;
        var propDy: f32;

        if (sourceDist > 1e9) {
          // Plane wave - apply direction offset for direction bending
          let bentDirection = direction + directionOffsets[i];
          propDx = cos(bentDirection);
          propDy = sin(bentDirection);
          let projected = sampleX * propDx + sampleY * propDy;
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

          let invDist = select(0.0, 1.0 / distFromSource, distFromSource > 1e-4);
          propDx = toPointX * invDist;
          propDy = toPointY * invDist;
          phase = k * distFromSource - omega * time + phaseOffset + phaseCorrections[i];
        }

        let sinPhase = sin(phase);
        let cosPhase = cos(phase);
        let ampScaled = amplitude * ampMod;

        height += ampScaled * sinPhase;
        dhdt += -ampScaled * omega * cosPhase;

        // Analytic gradient. ∂phase/∂sampleX = k * propDx (true for both
        // plane and point waves — for point waves propDx is the unit
        // vector from source to sample, which equals ∂dist/∂sampleX).
        // ∂h/∂sampleX = A * ampMod * cos(phase) * k * propDx.
        let kCosAmp = k * cosPhase * ampScaled;
        dhdx += kCosAmp * propDx;
        dhdy += kCosAmp * propDy;

        // Horizontal orbital velocity (Gerstner time-derivative of displacement).
        // Q * A = steepness / (k * numWaves), independent of amplitude, so the
        // velocity magnitude depends only on wavenumber, steepness, and omega.
        // Scale by energy factor and ampMod to match the height attenuation.
        let velCoeff = (steepness / (k * f32(numWaves))) * omega * ampMod * energyFactors[i] * sinPhase;
        velX += velCoeff * propDx;
        velY += velCoeff * propDy;
      }

      var result: GerstnerWaveResult;
      result.height = height;
      result.dhdx = dhdx;
      result.dhdy = dhdy;
      result.velX = velX;
      result.velY = velY;
      result.dhdt = dhdt;
      return result;
    }
  `,
};
