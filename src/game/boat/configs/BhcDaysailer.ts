import { createBoatConfig } from "../BoatConfig";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Catalina 22: LOA 21.5ft, beam 7.67ft, draft 5.0ft (swing keel down), disp 2490 lbs, ballast 800 lbs (32%)
const sx = 0.956; // 21.5 / 22.5
const sy = 0.956; // uniform (beam scales similarly)
const sz = sx;

/**
 * BHC Daysailer — 21ft swing-keel family daysailer (inspired by Catalina 22)
 * The most approachable boat on the water. The swing keel keeps her stable
 * and forgiving in gusts; basic sails mean you don't need to sweat the
 * trim. Great for learning, lazy afternoons, and keeping everyone aboard happy.
 *
 * Inspired by: Catalina 22 (LOA 21.5ft, disp 2490 lbs, ballast 800 lbs, SA 212 sqft)
 */
export const BhcDaysailer = createBoatConfig(
  scaleBoatConfig(Kestrel, sx, sy, sz),
  {
    hull: {
      mass: 1240,
      skinFrictionCoefficient: 0.0035, // production gelcoat hull
      colors: {
        fill: 0xd8c89c, // warm cream deck
        stroke: 0x6a4a1a, // brown trim
        side: 0xd0c090, // tan topsides
        bottom: 0x4a3018, // dark mahogany
      },
    },
    keel: {
      draft: 5.0, // swing keel fully down
      color: 0x5a4030,
    },
    rudder: {
      draft: 2.87,
      steerAdjustSpeed: 0.65, // forgiving, gentle response
      steerAdjustSpeedFast: 1.6,
      color: 0x5a4030,
    },
    rig: {
      colors: {
        mast: 0xa09080,
        boom: 0x8a6a40,
      },
      mainsail: {
        liftScale: 0.92, // basic production sails
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
      groundingDamageRate: 0.12, // solid gelcoat construction
    },
    tilt: {
      rollInertia: 16230,
      pitchInertia: 71939,
      rollDamping: 28264,
      pitchDamping: 62985,
      rightingMomentCoeff: 307638, // GM 3.84ft — noticeably stiffer than S-7
      pitchRightingCoeff: 344556,
      waveRollCoeff: 3000,
      wavePitchCoeff: 2300,
    },
    buoyancy: {
      verticalMass: 2490,
      rollInertia: 16230,
      pitchInertia: 71939,
      centerOfGravityZ: -1.5,
      zHeights: {
        keel: -5.0,
      },
    },
  },
);
