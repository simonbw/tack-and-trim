import { createBoatConfig } from "../BoatConfig";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// J/105: LOA 34.5ft, beam 11ft, draft 6.5ft, disp 7750 lbs, ballast 3400 lbs (44%)
const sx = 1.533; // 34.5 / 22.5
const sy = 1.375; // (11 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Shaff S-11 — 33ft performance keelboat (inspired by J/105)
 * A serious one-design racer. Stiff for her weight thanks to a deep fin keel,
 * carries sail well, and rewards aggressive upwind work. Non-overlapping jib
 * means tacks are fast and clean.
 *
 * Inspired by: J/105 (LOA 34.5ft, disp 7750 lbs, ballast 3400 lbs 44%, SA 581 sqft)
 */
export const ShaffS11 = createBoatConfig(scaleBoatConfig(Kestrel, sx, sy, sz), {
  hull: {
    mass: 3450,
    skinFrictionCoefficient: 0.0025,
    colors: {
      fill: 0xf0f0f0,
      stroke: 0x1a1a1a,
      side: 0xe0e0f0,
      bottom: 0x0f1f2f,
    },
  },
  keel: {
    draft: 6.5,
    color: 0x222222,
  },
  rudder: {
    draft: 4.6,
    steerAdjustSpeed: 0.9,
    steerAdjustSpeedFast: 2.2,
    color: 0x222222,
  },
  rig: {
    colors: {
      mast: 0x999999,
      boom: 0x333333,
    },
    mainsail: {
      liftScale: 1.05,
      dragScale: 0.9,
      color: 0xfafafa,
    },
  },
  jib: {
    liftScale: 1.05,
    dragScale: 0.9,
    color: 0xfafafa,
  },
  mainsheet: {
    ropeColor: 0xee2222,
  },
  hullDamage: {
    groundingDamageRate: 0.2,
  },
  tilt: {
    rollInertia: 104147,
    pitchInertia: 576486,
    rollDamping: 122742,
    pitchDamping: 398276,
    rightingMomentCoeff: 904108, // GM 3.63ft — stiff racer (high ballast ratio)
    pitchRightingCoeff: 1719862,
    waveRollCoeff: 9000,
    wavePitchCoeff: 11000,
  },
  buoyancy: {
    verticalMass: 7750,
    rollInertia: 104147,
    pitchInertia: 576486,
    centerOfGravityZ: -2.2,
    zHeights: {
      keel: -6.5,
    },
  },
});
