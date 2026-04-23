import { V } from "../../../core/Vector";
import { createBoatConfig } from "../BoatConfig";
import { BHC_PALETTE, withBrandPalette } from "./brandPalettes";
import { scaleBoatConfig } from "./configScale";
import { BaseBoat } from "./BaseBoat";

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
  withBrandPalette(scaleBoatConfig(BaseBoat, sx, sy, sz), BHC_PALETTE),
  {
    hull: {
      mass: 10700,
      skinFrictionCoefficient: 0.0033,
    },
    keel: {
      draft: 6.0,
    },
    rudder: {
      draft: 5.6,
      steerAdjustSpeed: 0.62,
      steerAdjustSpeedFast: 1.5,
    },
    helm: {
      type: "wheel",
      position: V(-12.5, 0),
      radius: 2.0,
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
