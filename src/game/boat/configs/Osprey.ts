import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Osprey - A fast 26ft sportboat (inspired by J/80)
 * More power and stability than the Kestrel, with a fin keel
 * and larger rig. Rewards aggressive sailing and crew coordination.
 */
export const Osprey: BoatConfig = {
  hull: {
    mass: 1400, // lbs - structural mass for 2D physics
    vertices: [
      // Stern (transom)
      V(-11.5, -1.8),
      V(-11.0, -3.0),
      // Starboard side
      V(-5, -4.375),
      V(1, -4.375),
      V(7, -3.4),
      V(11.5, -1.8),
      // Bow
      V(14.75, 0),
      // Port side
      V(11.5, 1.8),
      V(7, 3.4),
      V(1, 4.375),
      V(-5, 4.375),
      V(-11.0, 3.0),
      V(-11.5, 1.8),
    ], // ~26.25 ft LOA, ~8.75 ft beam
    waterlineVertices: [
      V(-11.3, -1.4),
      V(-10.8, -2.4),
      V(-5, -3.6),
      V(1, -3.6),
      V(7, -2.8),
      V(11.3, -1.4),
      V(14.4, 0),
      V(11.3, 1.4),
      V(7, 2.8),
      V(1, 3.6),
      V(-5, 3.6),
      V(-10.8, 2.4),
      V(-11.3, 1.4),
    ], // ~25.7 ft WLL, ~7.2 ft waterline beam
    bottomVertices: [
      V(-11.0, -0.55),
      V(-10.5, -1.0),
      V(-5, -1.5),
      V(1, -1.5),
      V(7, -1.2),
      V(11.0, -0.55),
      V(14.0, 0),
      V(11.0, 0.55),
      V(7, 1.2),
      V(1, 1.5),
      V(-5, 1.5),
      V(-10.5, 1.0),
      V(-11.0, 0.55),
    ], // ~25.0 ft, ~3.0 ft bottom beam
    skinFrictionCoefficient: 0.003,
    stagnationCoefficient: 0.4, // placeholder until precomputed separation model (#125)
    separationCoefficient: 0.12, // placeholder until precomputed separation model (#125)
    draft: 1.2, // ft below waterline (hull bottom)
    deckHeight: 3.0, // ft above waterline
    colors: {
      fill: 0xb8935a, // warm oak deck
      stroke: 0x5c3a1e, // dark walnut trim
      side: 0x9a7842,
      bottom: 0x4a2e18, // dark mahogany hull
    },
  },

  keel: {
    vertices: [V(-3, 0), V(3, 0)], // 6ft span fin keel (shorter along hull, deeper)
    draft: 5.0, // ft below waterline
    chord: 2.5, // ft
    color: 0x4a3a3d,
  },

  rudder: {
    position: V(-11, 0), // At transom
    length: 3.0, // ft
    draft: 4.0, // ft below waterline
    chord: 2.5, // ft
    maxSteerAngle: degToRad(30),
    steerAdjustSpeed: 0.7,
    steerAdjustSpeedFast: 1.8,
    color: 0x4a3a3d,
  },

  rig: {
    mastPosition: V(6, 0), // ~40% from bow
    boomLength: 11, // ft
    boomWidth: 0.55, // ft
    boomMass: 25, // lbs
    colors: {
      mast: 0x4a3a3d,
      boom: 0x997744,
    },
    mainsail: {
      nodeMass: 1.0,
      liftScale: 1.2,
      dragScale: 1.0,
      hoistSpeed: 0.3,
      color: 0xeeeeff,
      zFoot: 5.0,
      zHead: 34,
    },
    stays: {
      forestay: V(17.75, 0), // at bowsprit tip
      portShroud: V(4, 4.2),
      starboardShroud: V(4, -4.2),
      backstay: V(-11.5, 0),
      deckHeight: 3.0,
    },
  },

  bowsprit: {
    attachPoint: V(14.75, 0),
    size: V(3, 0.5),
    color: 0x775533,
  },

  lifelines: {
    // Stanchion positions interpolated along hull deck edge vertices
    portStanchions: [
      [7, 3.4], // on hull edge at forward quarter
      [1, 4.375], // at max beam
      [-5, 4.375], // at max beam, aft
      [-9, 3.2], // aft quarter, interpolated toward stern
    ],
    starboardStanchions: [
      [7, -3.4],
      [1, -4.375],
      [-5, -4.375],
      [-9, -3.2],
    ],
    bowPulpit: [
      [10, -2.4],
      [13, -1.1],
      [14.75, 0],
      [13, 1.1],
      [10, 2.4],
    ],
    sternPulpit: [
      [-11.0, -3.0],
      [-11.5, -1.8],
      [-11.5, 0],
      [-11.5, 1.8],
      [-11.0, 3.0],
    ],
    stanchionHeight: 2.0,
    tubeColor: 0xbbbbbb,
    wireColor: 0x999999,
    tubeWidth: 0.2,
    wireWidth: 0.1,
  },

  anchor: {
    bowAttachPoint: V(14.75, 0),
    maxRodeLength: 80, // ft
    anchorSize: 1.5, // ft
    rodeDeploySpeed: 18,
    rodeRetrieveSpeed: 10,
    anchorMass: 25, // lbs
    anchorDragCoefficient: 600,
  },

  jib: {
    nodeMass: 0.8,
    liftScale: 1.2,
    dragScale: 1.0,
    hoistSpeed: 0.35,
    color: 0xeeeeff,
  },

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-9, 0),
    minLength: 3,
    maxLength: 14,
    defaultLength: 7,
    trimSpeed: 2.5,
    easeSpeed: 2.5,
    ropeThickness: 0.35,
  },

  jibSheet: {
    portAttachPoint: V(-7, 4.0),
    starboardAttachPoint: V(-7, -4.0),
    minLength: 7,
    maxLength: 20,
    defaultLength: 14,
    trimSpeed: 4.5,
    easeSpeed: 14,
    ropeThickness: 0.35,
  },

  rowing: {
    duration: 0.8,
    force: 10000, // lbf
  },

  grounding: {
    keelFriction: 1200,
    rudderFriction: 750,
    hullFriction: 5000,
  },

  bilge: {
    maxWaterVolume: 18, // cubic ft
    bailBucketSize: 0.5,
    bailInterval: 1.0,
    waterDensity: 64,
    ingressCoefficient: 1.2,
    sloshGravity: 3.5,
    sloshDamping: 2.0,
    halfBeam: 4.375,
    sinkingDuration: 6.0,
  },

  hullDamage: {
    groundingDamageRate: 0.12,
    groundingSpeedThreshold: 0.8, // ft/s
    damageFrictionMultiplier: 1.8,
    damageLeakRate: 0.5,
    repairRate: 0,
  },

  rudderDamage: {
    groundingDamageRate: 0.2,
    groundingSpeedThreshold: 0.7, // ft/s
    maxSteeringReduction: 0.7,
    maxSteeringBias: 0.25,
    repairRate: 0,
  },

  sailDamage: {
    overpowerForceThreshold: 900, // lbf
    overpowerDamageRate: 0.00003,
    jibeDamagePerForce: 0.00006,
    maxLiftReduction: 0.6,
    repairRate: 0,
  },

  // Tilt parameters derived from hull geometry and ~2800 lb displacement
  // (1400 lb hull + 1050 lb keel ballast + ~350 lb crew/equipment).
  // GM_roll ≈ 3.5 ft (fin keel, good stability).
  tilt: {
    rollInertia: 23819, // 2800 * (8.75/3)² = 2800 * 8.507
    pitchInertia: 120469, // 2800 * (26.25/4)² = 2800 * 43.07
    rollDamping: 34627, // 0.4 * sqrt(23819 * 315312)
    pitchDamping: 93226, // 0.4 * sqrt(120469 * 450446)
    rightingMomentCoeff: 315312, // 2800 * 32.174 * 3.5
    pitchRightingCoeff: 450446, // 2800 * 32.174 * 5.0
    waveRollCoeff: 3000,
    wavePitchCoeff: 3000,
    zHeights: {
      deck: 1.5,
      boom: 5.0,
      mastTop: 34,
      keel: -5.0,
      rudder: -2.0,
      bowsprit: 3.0,
    },
  },

  buoyancy: {
    verticalMass: 2800, // total displacement
    rollInertia: 23819,
    pitchInertia: 120469,
    centerOfGravityZ: -1.5, // ft — below waterline (fin keel ballast)
    zHeights: {
      deck: 1.5,
      boom: 5.0,
      mastTop: 34,
      keel: -5.0,
      rudder: -2.0,
      bowsprit: 3.0,
    },
  },
};
