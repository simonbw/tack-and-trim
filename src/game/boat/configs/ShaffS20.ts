import { V } from "../../../core/Vector";
import { createBoatConfig } from "../BoatConfig";
import { SHAFF_PALETTE, withBrandPalette } from "./brandPalettes";
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
export const ShaffS20 = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), SHAFF_PALETTE),
  {
    hull: {
      mass: 33500,
      skinFrictionCoefficient: 0.0023, // highly faired race hull
    },
    keel: {
      draft: 9.17,
    },
    rudder: {
      draft: 8.0,
      steerAdjustSpeed: 0.75,
      steerAdjustSpeedFast: 1.8,
    },
    helm: {
      type: "wheel",
      position: V(-18, 0),
      radius: 2.8,
      turns: 1.5,
    },
    rig: {
      mainsail: {
        liftScale: 1.08,
        dragScale: 0.88,
      },
    },
    jib: {
      liftScale: 1.08,
      dragScale: 0.88,
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
  },
);
