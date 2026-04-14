import { createBoatConfig } from "../BoatConfig";
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
  scaleBoatConfig(Kestrel, sx, sy, sz),
  {
    hull: {
      mass: 7587,
      skinFrictionCoefficient: 0.0027,
      colors: {
        fill: 0xe8e0cc,
        stroke: 0xb09030,
        side: 0x1a2a50,
        bottom: 0x080f1e,
      },
    },
    keel: {
      draft: 6.4,
      color: 0x303060,
    },
    rudder: {
      draft: 4.7,
      steerAdjustSpeed: 0.78,
      steerAdjustSpeedFast: 1.95,
      color: 0x303060,
    },
    rig: {
      colors: {
        mast: 0xbbbbcc,
        boom: 0xb09030,
      },
      mainsail: {
        liftScale: 1.0,
        dragScale: 0.95,
        color: 0xf4f2ee,
      },
    },
    jib: {
      liftScale: 1.0,
      dragScale: 0.95,
      color: 0xf4f2ee,
    },
    mainsheet: {
      ropeColor: 0x0a1a40,
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
