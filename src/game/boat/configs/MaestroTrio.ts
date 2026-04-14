import { createBoatConfig } from "../BoatConfig";
import { MAESTRO_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Dehler 34: LOA 35.1ft, beam 11.8ft, draft 6.4ft, disp 13117 lbs, ballast 4630 lbs (35%)
const sx = 1.56; // 35.1 / 22.5
const sy = 1.475; // (11.8 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Maestro Trio — 35ft luxury racer-cruiser (inspired by Dehler 34)
 * The Trio is where Maestro's engineering really shows. More sail area than
 * anything else in the M class, a beautifully balanced helm, and enough
 * interior to mean something. Fast upwind, composed downwind, and impeccably
 * finished throughout.
 *
 * Inspired by: Dehler 34 (LOA 35.1ft, disp 13117 lbs, ballast 4630 lbs, SA 700 sqft, SA/D 18.5)
 */
export const MaestroTrio = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), MAESTRO_PALETTE),
  {
    hull: {
      mass: 7587,
      skinFrictionCoefficient: 0.0027,
    },
    keel: {
      draft: 6.4,
    },
    rudder: {
      draft: 4.7,
      steerAdjustSpeed: 0.78,
      steerAdjustSpeedFast: 1.95,
    },
    rig: {
      mainsail: {
        liftScale: 1.0,
        dragScale: 0.95,
      },
    },
    jib: {
      liftScale: 1.0,
      dragScale: 0.95,
    },
    hullDamage: {
      groundingDamageRate: 0.13,
    },
    tilt: {
      rollInertia: 202453,
      pitchInertia: 1009668,
      rollDamping: 260366,
      pitchDamping: 691762,
      rightingMomentCoeff: 2093017, // GM 4.96ft — firm and confident
      pitchRightingCoeff: 2962006,
      waveRollCoeff: 20700,
      wavePitchCoeff: 19500,
    },
    buoyancy: {
      verticalMass: 13117,
      rollInertia: 202453,
      pitchInertia: 1009668,
      centerOfGravityZ: -2.0,
      zHeights: {
        keel: -6.4,
      },
    },
  },
);
