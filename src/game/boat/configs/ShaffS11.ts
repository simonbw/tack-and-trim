import { createBoatConfig } from "../BoatConfig";
import { SHAFF_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// J/105: LOA 34.5ft, beam 11ft, draft 6.5ft, disp 7750 lbs, ballast 3400 lbs (44%)
const sx = 1.533; // 34.5 / 22.5
const sy = 1.375; // (11 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Shaff S-11 — 33ft performance keelboat (inspired by J/105)
 * A serious one-design racer. Stiff for her weight thanks to a deep fin keel,
 * carries sail well, and rewards aggressive upwind work. Non-overlapping jib
 * means tacks are fast and clean.
 *
 * Inspired by: J/105 (LOA 34.5ft, disp 7750 lbs, ballast 3400 lbs 44%, SA 581 sqft)
 */
export const ShaffS11 = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), SHAFF_PALETTE),
  {
    hull: {
      mass: 3450,
      skinFrictionCoefficient: 0.0025,
    },
    keel: {
      draft: 6.5,
    },
    rudder: {
      draft: 4.6,
      steerAdjustSpeed: 0.9,
      steerAdjustSpeedFast: 2.2,
    },
    rig: {
      mainsail: {
        liftScale: 1.05,
        dragScale: 0.9,
      },
    },
    jib: {
      liftScale: 1.05,
      dragScale: 0.9,
    },
    hullDamage: {
      groundingDamageRate: 0.2,
    },
    tilt: {
      rollInertia: 104147,
      pitchInertia: 576486,
      rollDamping: 122742,
      pitchDamping: 398276,
      rightingMomentCoeff: 904108, // GM 3.63ft — stiff racer (high ballast ratio)
      pitchRightingCoeff: 1719862,
      waveRollCoeff: 9000,
      wavePitchCoeff: 11000,
    },
    buoyancy: {
      verticalMass: 7750,
      rollInertia: 104147,
      pitchInertia: 576486,
      centerOfGravityZ: -2.2,
      zHeights: {
        keel: -6.5,
      },
    },
  },
);
