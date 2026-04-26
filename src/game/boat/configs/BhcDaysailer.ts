import { createBoatConfig } from "../BoatConfig";
import { BHC_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { BaseBoat } from "./BaseBoat";
import { withMainsailOnly } from "./withMainsailOnly";

// Catalina 22: LOA 21.5ft, beam 7.67ft, draft 5.0ft (swing keel down), disp 2490 lbs, ballast 800 lbs (32%)
const sx = 0.956; // 21.5 / 22.5
const sy = 0.956; // uniform (beam scales similarly)
const sz = sx;

/**
 * BHC Daysailer — 21ft swing-keel family daysailer (inspired by Catalina 22)
 * The most approachable boat on the water. The swing keel keeps her stable
 * and forgiving in gusts; the single-mainsail rig means you don't need to
 * sweat the trim. Great for learning, lazy afternoons, and keeping everyone
 * aboard happy.
 *
 * Inspired by: Catalina 22 (LOA 21.5ft, disp 2490 lbs, ballast 800 lbs, SA 212 sqft)
 */
export const BhcDaysailer = createBoatConfig(
  withBrandPalette(
    scaleBoatConfig(withMainsailOnly(BaseBoat), sx, sy, sz),
    BHC_PALETTE,
  ),
  {
    hull: {
      mass: 1240,
      skinFrictionCoefficient: 0.0035, // production gelcoat hull
    },
    keel: {
      draft: 5.0, // swing keel fully down
    },
    rudder: {
      draft: 2.87,
      steerAdjustSpeed: 0.65, // forgiving, gentle response
      steerAdjustSpeedFast: 1.6,
    },
    rig: {
      mainsail: {
        liftScale: 0.92, // basic production sails
        dragScale: 1.05,
      },
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
