import { createBoatConfig } from "../BoatConfig";
import { SHAFF_PALETTE, withBrandPalette } from "./brandPalettes";
import { BaseBoat } from "./BaseBoat";

/**
 * Shaff S-7 — 21ft performance one-design racer (inspired by J/22)
 * The entry point to the Shaff lineup. Tender, quick to respond, demanding
 * in gusts but rewarding for skilled sailors. Racing sails, low freeboard,
 * no frills.
 *
 * Inspired by: J/22 (LOA 22.5ft, disp 1790 lbs, ballast 700 lbs, SA 226 sqft)
 */
export const ShaffS7 = createBoatConfig(
  withBrandPalette(BaseBoat, SHAFF_PALETTE),
  {
    hull: {
      mass: 640,
      skinFrictionCoefficient: 0.0025, // faired racing hull
    },
    keel: {
      draft: 3.83,
    },
    rudder: {
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
      groundingDamageRate: 0.2, // racing hull — lighter layup
    },
    tilt: {
      rollInertia: 12729,
      pitchInertia: 56635,
      rollDamping: 17602,
      pitchDamping: 48466,
      rightingMomentCoeff: 152082, // GM 2.64ft — tender racer
      pitchRightingCoeff: 259201,
      waveRollCoeff: 1500,
      wavePitchCoeff: 1700,
    },
    buoyancy: {
      verticalMass: 1790,
      rollInertia: 12729,
      pitchInertia: 56635,
      centerOfGravityZ: -1.1,
      zHeights: {
        keel: -3.83,
      },
    },
  },
);
