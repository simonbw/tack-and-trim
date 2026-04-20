import { V } from "../../../core/Vector";
import { createBoatConfig } from "../BoatConfig";
import { SHAFF_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// J/133: LOA 43ft, beam 12.75ft, draft 7.5ft, disp 17900 lbs, ballast 6900 lbs (38.5%)
const sx = 1.911; // 43.0 / 22.5
const sy = 1.594; // (12.75 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Shaff S-15 — 45ft offshore performance racer (inspired by J/133)
 * Lean and fast for her size. A boat for experienced crews who understand
 * how to manage a big fractional rig in varying conditions. Plenty of power
 * on a reach, exhilarating upwind, demanding downwind.
 *
 * Inspired by: J/133 (LOA 43ft, disp 17900 lbs, ballast 6900 lbs, SA 983 sqft)
 */
export const ShaffS15 = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), SHAFF_PALETTE),
  {
    hull: {
      mass: 9500,
      skinFrictionCoefficient: 0.0025,
    },
    keel: {
      draft: 7.5,
    },
    rudder: {
      draft: 5.7,
      steerAdjustSpeed: 0.85,
      steerAdjustSpeedFast: 2.0,
    },
    helm: {
      type: "wheel",
      position: V(-13, 0),
      radius: 2.0,
      turns: 1.5,
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
      groundingDamageRate: 0.18,
    },
    tilt: {
      rollInertia: 323287,
      pitchInertia: 2068490,
      rollDamping: 354124,
      pitchDamping: 1280000,
      rightingMomentCoeff: 2424593, // GM 4.21ft — reasonably tender for size
      pitchRightingCoeff: 4951000,
      waveRollCoeff: 24000,
      wavePitchCoeff: 32500,
    },
    buoyancy: {
      verticalMass: 17900,
      rollInertia: 323287,
      pitchInertia: 2068490,
      centerOfGravityZ: -2.8,
      zHeights: {
        keel: -7.5,
      },
    },
  },
);
