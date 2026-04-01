import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Albatross - A powerful 40ft performance cruiser (inspired by J/122)
 * Heavy displacement, deep fin keel, and a massive rig. Very stable
 * and fast in a straight line, but slow to tack and hard to stop.
 * Rewards planning ahead and smooth, deliberate helming.
 */
export const Albatross: BoatConfig = {
  hull: {
    mass: 8000, // lbs - structural mass for 2D physics
    vertices: [
      // Stern (transom)
      V(-17, -2.5),
      V(-16.5, -4.5),
      // Starboard side
      V(-8, -6.25),
      V(0, -6.25),
      V(9, -5.0),
      V(17, -2.5),
      // Bow
      V(23.4, 0),
      // Port side
      V(17, 2.5),
      V(9, 5.0),
      V(0, 6.25),
      V(-8, 6.25),
      V(-16.5, 4.5),
      V(-17, 2.5),
    ], // ~40.4 ft LOA, ~12.5 ft beam
    waterlineVertices: [
      V(-16.7, -2.0),
      V(-16.2, -3.6),
      V(-8, -5.2),
      V(0, -5.2),
      V(9, -4.1),
      V(16.7, -2.0),
      V(22.8, 0),
      V(16.7, 2.0),
      V(9, 4.1),
      V(0, 5.2),
      V(-8, 5.2),
      V(-16.2, 3.6),
      V(-16.7, 2.0),
    ], // ~39.5 ft WLL, ~10.4 ft waterline beam
    bottomVertices: [
      V(-16.3, -0.8),
      V(-15.8, -1.5),
      V(-8, -2.2),
      V(0, -2.2),
      V(9, -1.7),
      V(16.3, -0.8),
      V(22.0, 0),
      V(16.3, 0.8),
      V(9, 1.7),
      V(0, 2.2),
      V(-8, 2.2),
      V(-15.8, 1.5),
      V(-16.3, 0.8),
    ], // ~38.3 ft, ~4.4 ft bottom beam
    skinFrictionCoefficient: 0.003,
    stagnationCoefficient: 0.4, // placeholder until precomputed separation model (#125)
    separationCoefficient: 0.12, // placeholder until precomputed separation model (#125)
    draft: 1.8, // ft below waterline (hull bottom)
    deckHeight: 4.0, // ft above waterline
    colors: {
      fill: 0xa07848, // rich cedar deck
      stroke: 0x3e2410, // deep mahogany trim
      side: 0x86602e,
      bottom: 0x33200e, // dark varnished hull
    },
  },

  keel: {
    vertices: [V(-4, 0), V(4, 0)], // 8ft span deep fin keel
    draft: 7.5, // ft below waterline
    chord: 3.5, // ft
    color: 0x4a3a3d,
  },

  rudder: {
    position: V(-16.5, 0), // At transom
    length: 4.0, // ft
    draft: 5.5, // ft below waterline
    chord: 3.5, // ft
    maxSteerAngle: degToRad(28),
    steerAdjustSpeed: 0.5,
    steerAdjustSpeedFast: 1.2,
    color: 0x4a3a3d,
  },

  rig: {
    mastPosition: V(9, 0), // ~40% from bow
    boomLength: 15, // ft
    boomWidth: 0.65, // ft
    boomMass: 55, // lbs
    colors: {
      mast: 0x4a3a3d,
      boom: 0x997744,
    },
    mainsail: {
      nodeMass: 1.5,
      liftScale: 1.5,
      dragScale: 1.0,
      hoistSpeed: 0.2,
      color: 0xeeeeff,
      clothColumns: 48,
      clothRows: 24,
      zFoot: 6.0,
      zHead: 52,
    },
    stays: {
      forestay: V(27, 0), // at bowsprit tip
      portShroud: V(6, 6.0),
      starboardShroud: V(6, -6.0),
      backstay: V(-17, 0),
      deckHeight: 4.0,
    },
  },

  bowsprit: {
    attachPoint: V(23, 0),
    size: V(4, 0.6),
    color: 0x775533,
  },

  lifelines: {
    // Stanchion positions interpolated along hull deck edge vertices
    portStanchions: [
      [13, 3.8], // forward, interpolated between V(17,2.5) and V(9,5.0)
      [9, 5.0], // on hull vertex
      [4.5, 5.6], // between V(9,5.0) and V(0,6.25)
      [0, 6.25], // at max beam
      [-8, 6.25], // on hull vertex
      [-13, 5.3], // aft, interpolated toward stern
    ],
    starboardStanchions: [
      [13, -3.8],
      [9, -5.0],
      [4.5, -5.6],
      [0, -6.25],
      [-8, -6.25],
      [-13, -5.3],
    ],
    bowPulpit: [
      [15.5, -3.2],
      [20, -1.7],
      [23.4, 0],
      [20, 1.7],
      [15.5, 3.2],
    ],
    sternPulpit: [
      [-16.5, -4.5],
      [-17, -2.5],
      [-17, 0],
      [-17, 2.5],
      [-16.5, 4.5],
    ],
    stanchionHeight: 2.5,
    tubeColor: 0xbbbbbb,
    wireColor: 0x999999,
    tubeWidth: 0.22,
    wireWidth: 0.11,
  },

  anchor: {
    bowAttachPoint: V(23.4, 0),
    maxRodeLength: 150, // ft
    anchorSize: 2.0, // ft
    rodeDeploySpeed: 15,
    rodeRetrieveSpeed: 8,
    anchorMass: 45, // lbs
    anchorDragCoefficient: 1200,
  },

  jib: {
    nodeMass: 1.2,
    liftScale: 1.5,
    dragScale: 1.0,
    hoistSpeed: 0.25,
    color: 0xeeeeff,
    clothColumns: 48,
    clothRows: 24,
  },

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-14, 0),
    minLength: 4,
    maxLength: 18,
    defaultLength: 9,
    trimSpeed: 2,
    easeSpeed: 2,
    ropeThickness: 0.4,
  },

  jibSheet: {
    portAttachPoint: V(-12, 5.5),
    starboardAttachPoint: V(-12, -5.5),
    minLength: 10,
    maxLength: 28,
    defaultLength: 18,
    trimSpeed: 3.5,
    easeSpeed: 12,
    ropeThickness: 0.4,
  },

  rowing: {
    duration: 1.0,
    force: 25000, // lbf - effectively auxiliary power for a boat this size
  },

  grounding: {
    keelFriction: 5000,
    rudderFriction: 3000,
    hullFriction: 20000,
  },

  bilge: {
    maxWaterVolume: 40, // cubic ft — large cockpit and cabin volume
    pumpDrainRate: 0.15, // cubic ft/s — small built-in bilge pump
    bailBucketSize: 0.6,
    bailInterval: 1.2,
    waterDensity: 64,
    ingressCoefficient: 0.8, // lower — higher freeboard means less water over the rail
    sloshGravity: 3.0,
    sloshDamping: 2.5,
    halfBeam: 6.25,
    sinkingDuration: 10.0,
  },

  hullDamage: {
    groundingDamageRate: 0.08, // heavy construction, more resistant
    groundingSpeedThreshold: 0.6, // ft/s — more momentum at low speeds
    damageFrictionMultiplier: 1.5,
    damageLeakRate: 0.8, // bigger hull, bigger leaks
    repairRate: 0,
  },

  rudderDamage: {
    groundingDamageRate: 0.15,
    groundingSpeedThreshold: 0.5, // ft/s
    maxSteeringReduction: 0.6,
    maxSteeringBias: 0.2,
    repairRate: 0,
  },

  sailDamage: {
    overpowerForceThreshold: 1800, // lbf — heavy rig, high threshold
    overpowerDamageRate: 0.00002,
    jibeDamagePerForce: 0.00004,
    maxLiftReduction: 0.5,
    repairRate: 0,
  },

  // Tilt parameters derived from hull geometry and ~16200 lb displacement
  // (8000 lb hull + 5800 lb keel ballast + ~2400 lb crew/equipment).
  // GM_roll ≈ 4.5 ft (deep fin keel + heavy ballast, very stiff).
  tilt: {
    rollInertia: 281250, // 16200 * (12.5/3)² = 16200 * 17.36
    pitchInertia: 1651050, // 16200 * (40.4/4)² = 16200 * 102.01
    rollDamping: 324850, // 0.4 * sqrt(281250 * 2347083)
    pitchDamping: 1049400, // 0.4 * sqrt(1651050 * 3486156)
    rightingMomentCoeff: 2347083, // 16200 * 32.174 * 4.5
    pitchRightingCoeff: 3486156, // 16200 * 32.174 * 6.69
    waveRollCoeff: 15000,
    wavePitchCoeff: 15000,
    zHeights: {
      deck: 2.0,
      boom: 6.0,
      mastTop: 52,
      keel: -7.5,
      rudder: -2.75,
      bowsprit: 4.0,
    },
  },

  buoyancy: {
    verticalMass: 16200, // total displacement
    rollInertia: 281250,
    pitchInertia: 1651050,
    centerOfGravityZ: -2.5, // ft — well below waterline (deep keel ballast)
    zHeights: {
      deck: 2.0,
      boom: 6.0,
      mastTop: 52,
      keel: -7.5,
      rudder: -2.75,
      bowsprit: 4.0,
    },
  },
};
