# Turbulence Diffusion

## Current State

Turbulence is calculated as an **instantaneous per-step quantity** in `marching.ts:644`:

```typescript
const turbulence = (energyBeforeDissipation - energy) * TURBULENCE_SCALE;
```

Each vertex gets only the energy dissipated at that exact marching step. There is no propagation between steps or between adjacent rays. This creates sharp on/off boundaries where breaking occurs rather than a natural foam field.

### Relevant files

- `src/game/wave-physics/mesh-building/marching.ts` — core marching loop, turbulence calculation, amplitude/diffraction post-processing
- `src/game/wave-physics/mesh-building/marchingTypes.ts` — `WavefrontSegment` with `turbulence: number[]`
- `src/game/wave-physics/mesh-building/marchingBuilder.ts` — orchestrates march → decimate → mesh pipeline

### Data structure context

- Marching iterates step-by-step downwave. Each step produces a `Wavefront` (array of `WavefrontSegment`s).
- Each ray in step N corresponds 1:1 with a ray in step N-1 by array index within the same segment (the `t` value is preserved).
- Segments can split (dead rays break a segment in two) and rays can be merged/split by `refineWavefront`, but `t` values are preserved through these operations.
- There's already precedent for cross-wave diffusion: `diffuseSegment()` does lateral amplitude diffusion (diffraction) using the same segment structure.

## Desired Changes

1. **Along-ray propagation**: Turbulence generated at step N should carry forward into step N+1, decaying with distance. The previous step's turbulence at each ray is sampled and added to the new local turbulence. Decay should be **phase-based** (decay per wavelength traveled) since this is the natural scale — a step covers `normalizedStep = localStep / wavelength` wavelengths, so the decay factor is `exp(-decayRate * normalizedStep)`. This keeps the foam trail length proportional to wavelength regardless of step size.

2. **Crosswave blur**: After each step's turbulence is finalized (local + carried), blur it laterally across the segment using a simple diffusion pass, similar to how `diffuseSegment` works for amplitude. This spreads foam sideways from breaking zones.

## Files to Modify

- `src/game/wave-physics/mesh-building/marching.ts`
  - Add turbulence decay constant (e.g. `TURBULENCE_DECAY_RATE = 2.0` — turbulence halves every ~0.35 wavelengths)
  - Add crosswave turbulence diffusion constant and iteration count
  - In the marching loop (line ~644): change turbulence calculation to accumulate from previous step's value with decay, plus new local dissipation
  - Add `diffuseTurbulence()` function (similar to `diffuseSegment`) for crosswave blur
  - Call `diffuseTurbulence()` from `postProcessStep()` after each step is produced

No other files need changes — the turbulence array already exists in `WavefrontSegment` and flows through decimation, mesh output, packing, and rasterization unchanged.

## Execution Order

All changes are in a single file (`marching.ts`), sequential:

1. **Add constants**: `TURBULENCE_DECAY_RATE`, `TURBULENCE_DIFFUSION_D`, `TURBULENCE_DIFFUSION_ITERATIONS`
2. **Modify marching loop** (line ~644): Replace instantaneous turbulence with accumulated value:
   ```typescript
   // Carry forward previous step's turbulence with phase-based decay
   const prevTurbulence = srcTurbulence[i];
   const carryOver = prevTurbulence * Math.exp(-TURBULENCE_DECAY_RATE * normalizedStep);
   // Add new local dissipation
   const localTurbulence = (energyBeforeDissipation - energy) * TURBULENCE_SCALE;
   const turbulence = carryOver + localTurbulence;
   ```
3. **Add `diffuseTurbulence()` function**: Lateral blur on a segment's turbulence array, modeled on `diffuseSegment`. Boundary conditions: 0 at both edges (foam doesn't leak into open ocean or shadow zones).
4. **Call from `postProcessStep()`**: Add `diffuseTurbulence` call after amplitude/diffraction processing.
5. **Tune constants**: Start with `TURBULENCE_DECAY_RATE = 2.0`, `TURBULENCE_DIFFUSION_ITERATIONS = 3`, adjust based on visual results.
