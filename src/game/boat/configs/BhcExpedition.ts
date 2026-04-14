import { createBoatConfig } from "../BoatConfig";
import { BHC_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Oyster 575: LOA 58.67ft, beam 16.42ft, draft 8.82ft, disp 58422 lbs, ballast 17855 lbs (30.6%)
const sx = 2.608; // 58.67 / 22.5
const sy = 2.053; // (16.42 / 2) / 4.0 half-beam
const sz = sx;

/**
 * BHC Expedition — 58ft long-range bluewater cruiser (inspired by Oyster 575)
 * Purpose-built for ocean passages. She's not built for speed — she's built
 * to handle anything the ocean throws at her and keep everyone safe and
 * comfortable. Heavy, wide, supremely stable. The boat you want when the
 * forecast turns bad three days from land.
 *
 * Inspired by: Oyster 575 (LOA 58.67ft, disp 58422 lbs, ballast 17855 lbs, SA 2097 sqft)
 */
export const BhcExpedition = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), BHC_PALETTE),
  {
    hull: {
      mass: 38067,
      skinFrictionCoefficient: 0.0033,
    },
    keel: {
      draft: 8.82,
    },
    rudder: {
      draft: 7.8,
      steerAdjustSpeed: 0.58,
      steerAdjustSpeedFast: 1.4,
    },
    rig: {
      mainsail: {
        liftScale: 0.92,
        dragScale: 1.05,
      },
    },
    jib: {
      liftScale: 0.92,
      dragScale: 1.05,
    },
    hullDamage: {
      groundingDamageRate: 0.08, // heavy offshore construction
    },
    tilt: {
      rollInertia: 1748827,
      pitchInertia: 12551719,
      rollDamping: 2078000,
      pitchDamping: 6652000,
      rightingMomentCoeff: 15429984, // GM 8.21ft — extremely stiff
      pitchRightingCoeff: 22041000,
      waveRollCoeff: 152000,
      wavePitchCoeff: 145000,
    },
    buoyancy: {
      verticalMass: 58422,
      rollInertia: 1748827,
      pitchInertia: 12551719,
      centerOfGravityZ: -3.2,
      zHeights: {
        keel: -8.82,
      },
    },
  },
);
