import { createBoatConfig } from "../BoatConfig";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Catalina 42 MkII: LOA 41.83ft, beam 13.83ft, draft 6.0ft, disp 20500 lbs, ballast 8300 lbs (40%)
const sx = 1.859; // 41.83 / 22.5
const sy = 1.729; // (13.83 / 2) / 4.0 half-beam
const sz = sx;

/**
 * BHC Journey — 42ft bluewater cruiser (inspired by Catalina 42)
 * Built for real passages. Wide, stable, and immensely livable. Not the
 * fastest boat in her size class, but she'll get you there comfortably and
 * come back for more. The kind of boat you buy to cross an ocean and end up
 * living aboard.
 *
 * Inspired by: Catalina 42 MkII (LOA 41.83ft, disp 20500 lbs, ballast 8300 lbs, SA 797 sqft)
 */
export const BhcJourney = createBoatConfig(
  scaleBoatConfig(Kestrel, sx, sy, sz),
  {
    hull: {
      mass: 10700,
      skinFrictionCoefficient: 0.0033,
      colors: {
        fill: 0xd8c89c,
        stroke: 0x6a4a1a,
        side: 0xd0c090,
        bottom: 0x4a3018,
      },
    },
    keel: {
      draft: 6.0,
      color: 0x5a4030,
    },
    rudder: {
      draft: 5.6,
      steerAdjustSpeed: 0.62,
      steerAdjustSpeedFast: 1.5,
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
      groundingDamageRate: 0.1,
    },
    tilt: {
      rollInertia: 435625,
      pitchInertia: 2230810,
      rollDamping: 564000,
      pitchDamping: 1403000,
      rightingMomentCoeff: 4564204, // GM 6.92ft — exceptionally stiff wide hull
      pitchRightingCoeff: 5520576,
      waveRollCoeff: 45000,
      wavePitchCoeff: 36000,
    },
    buoyancy: {
      verticalMass: 20500,
      rollInertia: 435625,
      pitchInertia: 2230810,
      centerOfGravityZ: -2.3,
      zHeights: {
        keel: -6.0,
      },
    },
  },
);
