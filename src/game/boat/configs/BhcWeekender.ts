import { V } from "../../../core/Vector";
import { createBoatConfig } from "../BoatConfig";
import { BHC_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { BaseBoat } from "./BaseBoat";

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
  withBrandPalette(scaleBoatConfig(BaseBoat, sx, sy, sz), BHC_PALETTE),
  {
    hull: {
      mass: 5100,
      skinFrictionCoefficient: 0.0033,
    },
    keel: {
      draft: 5.25,
    },
    rudder: {
      draft: 4.0,
      steerAdjustSpeed: 0.65,
      steerAdjustSpeedFast: 1.6,
    },
    helm: {
      type: "wheel",
      position: V(-9, 0),
      radius: 1.5,
      turns: 1.5,
    },
    rig: {
      mainsail: {
        liftScale: 0.92,
        dragScale: 1.05,
      },
    },
    jib: {
      liftScale: 0.92,
      dragScale: 1.05,
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
