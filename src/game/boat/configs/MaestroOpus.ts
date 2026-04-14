import { createBoatConfig } from "../BoatConfig";
import { MAESTRO_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Swan 60: LOA 61.9ft, beam 16.75ft, draft 9.8ft, disp 52250 lbs, ballast 18078 lbs (34.6%)
const sx = 2.751; // 61.9 / 22.5
const sy = 2.094; // (16.75 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Maestro Opus — 62ft grand prix luxury yacht (inspired by Nautor Swan 60)
 * The pinnacle of the Maestro lineup. Deep lead keel, carbon-reinforced hull,
 * and enough sail area to humble a crew of ten. She's fast offshore, composed
 * in heavy weather, and finishes the race looking like she never left the dock.
 * You do not buy an Opus — you earn one.
 *
 * Inspired by: Nautor Swan 60 FD (LOA 61.9ft, disp 52250 lbs, ballast 18078 lbs)
 */
export const MaestroOpus = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), MAESTRO_PALETTE),
  {
    hull: {
      mass: 31672,
      skinFrictionCoefficient: 0.0025, // premium fairing
    },
    keel: {
      draft: 9.8,
    },
    rudder: {
      draft: 8.3,
      steerAdjustSpeed: 0.72,
      steerAdjustSpeedFast: 1.8,
    },
    rig: {
      mainsail: {
        liftScale: 1.05,
        dragScale: 0.93,
      },
    },
    jib: {
      liftScale: 1.05,
      dragScale: 0.93,
    },
    hullDamage: {
      groundingDamageRate: 0.1,
    },
    tilt: {
      rollInertia: 1628603,
      pitchInertia: 12517233,
      rollDamping: 1756000,
      pitchDamping: 6456000,
      rightingMomentCoeff: 11834874, // GM 7.04ft — stable and powerful
      pitchRightingCoeff: 20804000,
      waveRollCoeff: 117000,
      wavePitchCoeff: 137000,
    },
    buoyancy: {
      verticalMass: 52250,
      rollInertia: 1628603,
      pitchInertia: 12517233,
      centerOfGravityZ: -3.4,
      zHeights: {
        keel: -9.8,
      },
    },
  },
);
