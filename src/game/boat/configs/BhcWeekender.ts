import { createBoatConfig } from "../BoatConfig";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Catalina 30: LOA 29.92ft, beam 10.83ft, draft 5.25ft, disp 10200 lbs, ballast 4200 lbs (41%)
const sx = 1.33; // 29.92 / 22.5
const sy = 1.354; // (10.83 / 2) / 4.0 half-beam
const sz = sx;

/**
 * BHC Weekender — 30ft cruiser-racer (inspired by Catalina 30)
 * Six thousand hulls built for a reason. Comfortable enough for overnight
 * passages, capable enough for club racing. Forgiving in a seaway, easy to
 * singlehand, and impossible to embarrass yourself on.
 *
 * Inspired by: Catalina 30 (LOA 29.92ft, disp 10200 lbs, ballast 4200 lbs, SA ~542 sqft)
 */
export const BhcWeekender = createBoatConfig(
  scaleBoatConfig(Kestrel, sx, sy, sz),
  {
    hull: {
      mass: 5100,
      skinFrictionCoefficient: 0.0033,
      colors: {
        fill: 0xd8c89c,
        stroke: 0x6a4a1a,
        side: 0xd0c090,
        bottom: 0x4a3018,
      },
    },
    keel: {
      draft: 5.25,
      color: 0x5a4030,
    },
    rudder: {
      draft: 4.0,
      steerAdjustSpeed: 0.65,
      steerAdjustSpeedFast: 1.6,
      color: 0x5a4030,
    },
    rig: {
      colors: {
        mast: 0xa09080,
        boom: 0x8a6a40,
      },
      mainsail: {
        liftScale: 0.92,
        dragScale: 1.05,
        color: 0xeeeedd,
      },
    },
    jib: {
      liftScale: 0.92,
      dragScale: 1.05,
      color: 0xeeeedd,
    },
    mainsheet: {
      ropeColor: 0xddddaa,
    },
    hullDamage: {
      groundingDamageRate: 0.12,
    },
    tilt: {
      rollInertia: 132704,
      pitchInertia: 570763,
      rollDamping: 194258,
      pitchDamping: 423424,
      rightingMomentCoeff: 1777750, // GM 5.42ft — very stiff for her size
      pitchRightingCoeff: 1962881,
      waveRollCoeff: 17500,
      wavePitchCoeff: 13000,
    },
    buoyancy: {
      verticalMass: 10200,
      rollInertia: 132704,
      pitchInertia: 570763,
      centerOfGravityZ: -1.7,
      zHeights: {
        keel: -5.25,
      },
    },
  },
);
