import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Kestrel - A nimble 22ft daysailer/racer (inspired by J/22)
 * Light, responsive keelboat with a swing keel. Great starter boat
 * that rewards good sail trim and is forgiving of mistakes.
 */
export const Kestrel: BoatConfig = {
  hull: {
    mass: 900, // lbs - structural mass for 2D physics
    vertices: [
      // Stern (transom)
      V(-9.5, -1.5),
      V(-9.0, -2.7),
      // Starboard side
      V(-4, -4.0),
      V(1, -4.0),
      V(6, -3.0),
      V(10, -1.5),
      // Bow
      V(13, 0), // Bow
      // Port side
      V(10, 1.5),
      V(6, 3.0),
      V(1, 4.0),
      V(-4, 4.0),
      V(-9.0, 2.7),
      V(-9.5, 1.5),
    ], // ~22.5 ft LOA, ~8.0 ft beam
    waterlineVertices: [
      V(-9.3, -1.15),
      V(-8.8, -2.1),
      V(-4, -3.3),
      V(1, -3.3),
      V(6, -2.5),
      V(9.8, -1.15),
      V(12.7, 0),
      V(9.8, 1.15),
      V(6, 2.5),
      V(1, 3.3),
      V(-4, 3.3),
      V(-8.8, 2.1),
      V(-9.3, 1.15),
    ], // ~22.0 ft WLL, ~6.6 ft waterline beam
    bottomVertices: [
      V(-9.0, -0.5),
      V(-8.5, -0.9),
      V(-4, -1.4),
      V(1, -1.4),
      V(6, -1.1),
      V(9.5, -0.5),
      V(12.3, 0),
      V(9.5, 0.5),
      V(6, 1.1),
      V(1, 1.4),
      V(-4, 1.4),
      V(-8.5, 0.9),
      V(-9.0, 0.5),
    ], // ~21.3 ft, ~2.8 ft bottom beam
    sharpVertices: [6], // bow
    skinFrictionCoefficient: 0.003,
    stagnationCoefficient: 0.4, // placeholder until precomputed separation model (#125)
    separationCoefficient: 0.12, // placeholder until precomputed separation model (#125)
    draft: 1.0, // ft below waterline (hull bottom)
    deckHeight: 2.5, // ft above waterline (gunwale freeboard)
    colors: {
      fill: 0xc4a46c, // light teak deck
      stroke: 0x7a5230, // dark wood trim
      side: 0xa8874e,
      bottom: 0x6b4226, // dark stained hull
    },
  },

  keel: {
    vertices: [V(-4, 0), V(4, 0)], // 8ft span swing keel
    draft: 3.75, // ft below waterline (keel down)
    chord: 2.0, // ft
    color: 0x4a3a3d,
  },

  rudder: {
    position: V(-10, 0), // Behind transom (stock hangs off stern)
    length: 2.5, // ft
    draft: 3.0, // ft below waterline
    chord: 2.0, // ft
    maxSteerAngle: degToRad(35),
    steerAdjustSpeed: 0.8,
    steerAdjustSpeedFast: 2.0,
    color: 0x4a3a3d,
  },

  rig: {
    mastPosition: V(5, 0), // ~40% from bow
    boomLength: 9.5, // ft
    boomWidth: 0.5, // ft
    boomMass: 18, // lbs
    colors: {
      mast: 0x4a3a3d,
      boom: 0x997744,
    },
    mainsail: {
      nodeMass: 0.8,
      liftScale: 1.0,
      dragScale: 1.0,
      hoistSpeed: 0.35,
      color: 0xeeeeff,
      zFoot: 4.0,
      zHead: 26,
    },
    stays: {
      forestay: V(15.4, 0), // at bowsprit tip
      portShroud: V(3.5, 3.3),
      starboardShroud: V(3.5, -3.3),
      backstay: V(-9.5, 0),
      deckHeight: 2.5,
    },
  },

  bowsprit: {
    attachPoint: V(12.9, 0),
    size: V(2.5, 0.35),
    color: 0x775533,
  },

  lifelines: {
    // Stanchion positions interpolated along hull deck edge vertices
    portStanchions: [
      [6.0, 2.85], // between bow shoulder and max beam
      [1, 3.85], // at max beam
      [-4, 3.85], // at max beam, aft
    ],
    starboardStanchions: [
      [6.0, -2.85],
      [1, -3.85],
      [-4, -3.85],
    ],
    bowPulpit: [
      [8.5, -2.0],
      [11, -1.0],
      [13, 0],
      [11, 1.0],
      [8.5, 2.0],
    ],
    sternPulpit: [
      [-8.85, -2.47],
      [-9.35, -1.27],
      [-9.35, 0],
      [-9.35, 1.27],
      [-8.85, 2.47],
    ],
    stanchionHeight: 1.5,
    tubeColor: 0xbbbbbb,
    wireColor: 0x999999,
    tubeWidth: 0.2,
    wireWidth: 0.1,
  },

  anchor: {
    bowAttachPoint: V(13, 0),
    maxRodeLength: 60, // ft
    anchorSize: 1.2, // ft
    rodeDeploySpeed: 20,
    rodeRetrieveSpeed: 12,
    anchorMass: 15, // lbs
    anchorDragCoefficient: 400,
  },

  jib: {
    nodeMass: 0.6,
    liftScale: 1.0,
    dragScale: 1.0,
    hoistSpeed: 0.4,
    color: 0xeeeeff,
  },

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-7, 0),
    minLength: 2,
    maxLength: 12,
    defaultLength: 6,
    trimSpeed: 3,
    easeSpeed: 3,
    ropeThickness: 0.3,
  },

  jibSheet: {
    portAttachPoint: V(-5, 3.5),
    starboardAttachPoint: V(-5, -3.5),
    minLength: 6,
    maxLength: 18,
    defaultLength: 12,
    trimSpeed: 5,
    easeSpeed: 15,
    ropeThickness: 0.3,
  },

  rowing: {
    duration: 0.7,
    force: 7000, // lbf
  },

  grounding: {
    keelFriction: 800,
    rudderFriction: 500,
    hullFriction: 3200,
  },

  bilge: {
    maxWaterVolume: 12, // cubic ft
    bailBucketSize: 0.4,
    bailInterval: 1.0,
    waterDensity: 64, // lbs/ft³ (saltwater)
    ingressCoefficient: 1.5,
    sloshGravity: 4.0,
    sloshDamping: 2.0,
    halfBeam: 4.0,
    sinkingDuration: 5.0,
  },

  hullDamage: {
    groundingDamageRate: 0.15,
    groundingSpeedThreshold: 1.0, // ft/s
    damageFrictionMultiplier: 2.0,
    damageLeakRate: 0.4, // cubic ft/s at 0 health
    repairRate: 0,
  },

  rudderDamage: {
    groundingDamageRate: 0.25,
    groundingSpeedThreshold: 0.8, // ft/s
    maxSteeringReduction: 0.7,
    maxSteeringBias: 0.3,
    repairRate: 0,
  },

  sailDamage: {
    overpowerForceThreshold: 600, // lbf
    overpowerDamageRate: 0.00004,
    jibeDamagePerForce: 0.00008,
    maxLiftReduction: 0.6,
    repairRate: 0,
  },

  // Tilt parameters derived from hull geometry and ~1790 lb displacement
  // (900 lb hull + 600 lb keel ballast + ~290 lb crew/equipment).
  // GM_roll ≈ 3.0 ft (swing keel, moderate form stability).
  tilt: {
    rollInertia: 12744, // 1790 * (8/3)² = 1790 * 7.11
    pitchInertia: 56600, // 1790 * (22.5/4)² = 1790 * 31.64
    rollDamping: 18727, // 0.4 * sqrt(12744 * 172774)
    pitchDamping: 48358, // 0.4 * sqrt(56600 * 259161)
    rightingMomentCoeff: 172774, // 1790 * 32.174 * 3.0
    pitchRightingCoeff: 259161, // 1790 * 32.174 * 4.5
    waveRollCoeff: 2000,
    wavePitchCoeff: 2000,
    zHeights: {
      deck: 1.2,
      boom: 4.0,
      mastTop: 26,
      keel: -3.75,
      rudder: -1.5,
      bowsprit: 2.5,
    },
  },

  buoyancy: {
    verticalMass: 1790, // total displacement
    rollInertia: 12744,
    pitchInertia: 56600,
    centerOfGravityZ: -1.2, // ft — below waterline (swing keel ballast)
    zHeights: {
      deck: 1.2,
      boom: 4.0,
      mastTop: 26,
      keel: -3.75,
      rudder: -1.5,
      bowsprit: 2.5,
    },
  },
};
