import { createBoatConfig } from "../BoatConfig";
import { MAESTRO_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// J/24: LOA 24ft, beam 8.9ft, draft 4.0ft, disp 3100 lbs, ballast 950 lbs (30.6%)
const sx = 1.067; // 24.0 / 22.5
const sy = 1.067; // uniform (beam 8.54ft vs actual 8.9ft — close enough)
const sz = sx;

/**
 * Maestro Etude — 24ft premium performance daysailer (inspired by J/24)
 * The smallest Maestro is the most fun. Slightly bigger and heavier than the
 * Shaff S-7, with a deeper feel and better ergonomics. The hull is hand-laid
 * and precisely faired; the sails are cut in-house. Faster than it looks,
 * more comfortable than it has any right to be.
 *
 * Inspired by: J/24 (LOA 24ft, disp 3100 lbs, ballast 950 lbs, SA 260 sqft)
 */
export const MaestroEtude = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), MAESTRO_PALETTE),
  {
    hull: {
      mass: 1700,
      skinFrictionCoefficient: 0.0028, // quality hand-laid hull
    },
    keel: {
      draft: 4.0,
    },
    rudder: {
      draft: 3.2,
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
      groundingDamageRate: 0.14,
    },
    tilt: {
      rollInertia: 25107,
      pitchInertia: 111600,
      rollDamping: 37940,
      pitchDamping: 92459,
      rightingMomentCoeff: 358241, // GM 3.59ft — balanced premium feel
      pitchRightingCoeff: 478753,
      waveRollCoeff: 3500,
      wavePitchCoeff: 3100,
    },
    buoyancy: {
      verticalMass: 3100,
      rollInertia: 25107,
      pitchInertia: 111600,
      centerOfGravityZ: -1.5,
      zHeights: {
        keel: -4.0,
      },
    },
  },
);
