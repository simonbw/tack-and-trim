import { createBoatConfig } from "../BoatConfig";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Jeanneau Sun Odyssey 45: LOA 45ft, beam 14.8ft, draft 6.7ft, disp 22250 lbs, ballast 6504 lbs
const sx = 2.0; // 45.0 / 22.5
const sy = 1.85; // (14.8 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Maestro Fantasia — 45ft premium bluewater performance cruiser (inspired by Jeanneau SO 45)
 * More sail area than the Shaff S-15, better stability than either competitor,
 * and a level of finish that makes the BHC Journey feel spartan. The Fantasia
 * is the boat you commission when you've already crossed an ocean and know
 * exactly what you want.
 *
 * Inspired by: Jeanneau Sun Odyssey 45 (LOA 45ft, disp 22250 lbs, SA 1122 sqft)
 */
export const MaestroFantasia = createBoatConfig(
  scaleBoatConfig(Kestrel, sx, sy, sz),
  {
    hull: {
      mass: 14246,
      skinFrictionCoefficient: 0.0027,
      colors: {
        fill: 0xe8e0cc,
        stroke: 0xb09030,
        side: 0x1a2a50,
        bottom: 0x080f1e,
      },
    },
    keel: {
      draft: 6.7,
      color: 0x303060,
    },
    rudder: {
      draft: 6.0,
      steerAdjustSpeed: 0.75,
      steerAdjustSpeedFast: 1.85,
      color: 0x303060,
    },
    rig: {
      colors: {
        mast: 0xbbbbcc,
        boom: 0xb09030,
      },
      mainsail: {
        liftScale: 1.02,
        dragScale: 0.95,
        color: 0xf4f2ee,
      },
    },
    jib: {
      liftScale: 1.02,
      dragScale: 0.95,
      color: 0xf4f2ee,
    },
    mainsheet: {
      ropeColor: 0x0a1a40,
    },
    hullDamage: {
      groundingDamageRate: 0.11,
    },
    tilt: {
      rollInertia: 540068,
      pitchInertia: 2815900,
      rollDamping: 620418,
      pitchDamping: 1703000,
      rightingMomentCoeff: 4452724, // GM 6.22ft — stable with generous beam
      pitchRightingCoeff: 6442848,
      waveRollCoeff: 44000,
      wavePitchCoeff: 42500,
    },
    buoyancy: {
      verticalMass: 22250,
      rollInertia: 540068,
      pitchInertia: 2815900,
      centerOfGravityZ: -2.5,
      zHeights: {
        keel: -6.7,
      },
    },
  },
);
