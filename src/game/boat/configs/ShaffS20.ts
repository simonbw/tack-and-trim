import { createBoatConfig } from "../BoatConfig";
import { scaleBoatConfig } from "./configScale";
import { Kestrel } from "./Kestrel";

// Farr 60: LOA 60.25ft, beam 18ft, draft 9.17ft, disp 54000 lbs, ballast 18000 lbs (33%)
const sx = 2.678; // 60.25 / 22.5
const sy = 2.25; // (18.0 / 2) / 4.0 half-beam
const sz = sx;

/**
 * Shaff S-20 — 60ft grand prix offshore racer (inspired by Farr 60)
 * The flagship Shaff. An ocean-going racing machine that demands a full
 * professional crew to sail well. Enormous sail area, fine entry, deep fin
 * keel — capable of sustained speeds that feel impossible until you've
 * experienced them.
 *
 * Inspired by: Farr 60 (LOA 60.25ft, disp 54000 lbs, ballast 18000 lbs, SA/D 23)
 */
export const ShaffS20 = createBoatConfig(scaleBoatConfig(Kestrel, sx, sy, sz), {
  hull: {
    mass: 33500,
    skinFrictionCoefficient: 0.0023, // highly faired race hull
    colors: {
      fill: 0xf0f0f0,
      stroke: 0x1a1a1a,
      side: 0xe0e0f0,
      bottom: 0x0f1f2f,
    },
  },
  keel: {
    draft: 9.17,
    color: 0x222222,
  },
  rudder: {
    draft: 8.0,
    steerAdjustSpeed: 0.75,
    steerAdjustSpeedFast: 1.8,
    color: 0x222222,
  },
  rig: {
    colors: {
      mast: 0x888888,
      boom: 0x2a2a2a,
    },
    mainsail: {
      liftScale: 1.08,
      dragScale: 0.88,
      color: 0xfafafa,
    },
  },
  jib: {
    liftScale: 1.08,
    dragScale: 0.88,
    color: 0xfafafa,
  },
  mainsheet: {
    ropeColor: 0xee2222,
  },
  hullDamage: {
    groundingDamageRate: 0.15,
  },
  tilt: {
    rollInertia: 1944000,
    pitchInertia: 12251520,
    rollDamping: 1792000,
    pitchDamping: 6406000,
    rightingMomentCoeff: 10320232, // GM 5.94ft — moderately tender for a 60-footer
    pitchRightingCoeff: 20935622,
    waveRollCoeff: 102000,
    wavePitchCoeff: 138000,
  },
  buoyancy: {
    verticalMass: 54000,
    rollInertia: 1944000,
    pitchInertia: 12251520,
    centerOfGravityZ: -3.5,
    zHeights: {
      keel: -9.17,
    },
  },
});
