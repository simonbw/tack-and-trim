import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Starter Boat - A small 12ft catboat with a single sail
 * Simple and forgiving, perfect for learning the basics of sailing.
 */
export const StarterBoat: BoatConfig = {
  hull: {
    mass: 250, // lbs - lighter than the sloop
    vertices: [
      // Stern (transom)
      V(-5.5, -1.1),
      V(-5.1, -1.95),
      // Starboard side
      V(-2.1, -2.8),
      V(1.7, -2.8),
      V(4.5, -2.2),
      V(6.8, -1.1),
      // Bow
      V(7.8, 0),
      // Port side
      V(6.8, 1.1),
      V(4.5, 2.2),
      V(1.7, 2.8),
      V(-2.1, 2.8),
      V(-5.1, 1.95),
      V(-5.5, 1.1),
    ], // ~12 ft LOA, ~5.6 ft beam
    waterlineVertices: [
      // Narrower shape at the waterline (below gunwales/flare)
      // Stern (transom)
      V(-5.3, -0.85),
      V(-4.9, -1.5),
      // Starboard side
      V(-2.1, -2.2),
      V(1.7, -2.2),
      V(4.5, -1.7),
      V(6.6, -0.85),
      // Bow
      V(7.5, 0),
      // Port side
      V(6.6, 0.85),
      V(4.5, 1.7),
      V(1.7, 2.2),
      V(-2.1, 2.2),
      V(-4.9, 1.5),
      V(-5.3, 0.85),
    ], // ~12.8 ft WLL, ~4.4 ft waterline beam
    bottomVertices: [
      // Narrowest cross-section at hull bottom
      // Stern
      V(-5.1, -0.4),
      V(-4.7, -0.65),
      // Starboard side
      V(-2.1, -1.0),
      V(1.7, -1.0),
      V(4.5, -0.75),
      V(6.4, -0.4),
      // Bow
      V(7.2, 0),
      // Port side
      V(6.4, 0.4),
      V(4.5, 0.75),
      V(1.7, 1.0),
      V(-2.1, 1.0),
      V(-4.7, 0.65),
      V(-5.1, 0.4),
    ], // ~12.3 ft, ~2.0 ft bottom beam
    skinFrictionCoefficient: 0.003,
    draft: 0.6, // ft below waterline
    deckHeight: 1.6, // ft above waterline (gunwale freeboard)
    colors: {
      fill: 0xccaa33,
      stroke: 0x886633,
      side: 0xbb9928,
      bottom: 0x886633, // same as deck outline
    },
  },

  keel: {
    vertices: [V(-4.2, 0), V(4.2, 0)], // 8.4ft span centerboard
    draft: 3.0, // ft below waterline
    color: 0x4a3a3d, // match rudder color
  },

  rudder: {
    position: V(-5.1, 0), // At transom
    length: 2.0, // ft (slightly smaller)
    draft: 2.0, // ft below waterline
    maxSteerAngle: degToRad(35),
    steerAdjustSpeed: 0.8,
    steerAdjustSpeedFast: 2.0,
    color: 0x4a3a3d,
  },

  rig: {
    mastPosition: V(2.5, 0), // ~35-40% from bow
    boomLength: 8, // ft (shorter boom)
    boomWidth: 0.45, // ft
    boomMass: 12, // lbs
    colors: {
      mast: 0x4a3a3d, // match keel/rudder
      boom: 0x997744,
    },
    mainsail: {
      nodeMass: 0.8,
      liftScale: 1.0,
      dragScale: 1.0,
      hoistSpeed: 0.4,
      color: 0xeeeeff,
    },
    stays: {
      forestay: V(8, 0), // just aft of bowsprit tip
      portShroud: V(1.5, 2.5),
      starboardShroud: V(1.5, -2.5),
      backstay: V(-5, 0),
      deckHeight: 1.6,
    },
  },

  lifelines: {
    portStanchions: [
      [3, 2.52],
      [-1.5, 2.8],
    ],
    starboardStanchions: [
      [3, -2.52],
      [-1.5, -2.8],
    ],
    // U-shape around bow: starboard → bow tip → port
    bowPulpit: [
      [5.5, -1.72],
      [7.0, -0.88],
      [7.8, 0],
      [7.0, 0.88],
      [5.5, 1.72],
    ],
    // Wrap around stern: starboard → port
    sternPulpit: [
      [-5.1, -1.95],
      [-5.5, -1.1],
      [-5.5, 0],
      [-5.5, 1.1],
      [-5.1, 1.95],
    ],
    stanchionHeight: 0.83, // ft above deck (~10 inches)
    tubeColor: 0xbbbbbb,
    wireColor: 0x999999,
    tubeWidth: 0.18,
    wireWidth: 0.09,
  },

  // No bowsprit on starter boat

  anchor: {
    bowAttachPoint: V(7.8, 0),
    maxRodeLength: 30, // ft
    anchorSize: 0.8, // ft
    rodeDeploySpeed: 20,
    rodeRetrieveSpeed: 12,
    anchorMass: 20, // lbs
    anchorDragCoefficient: 250,
  },

  // No jib on starter boat

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-4.2, 0),
    minLength: 1,
    maxLength: 9,
    defaultLength: 4.5,
    trimSpeed: 3,
    easeSpeed: 3,
    ropeThickness: 0.225,
  },

  // No jib sheets on starter boat

  rowing: {
    duration: 0.6,
    force: 4000, // lbf (lighter boat, less force needed)
  },

  grounding: {
    keelFriction: 400,
    rudderFriction: 250,
    hullFriction: 1600,
  },

  bilge: {
    maxWaterVolume: 6, // cubic ft — smaller cockpit than the dinghy (~45 gallons)
    bailBucketSize: 0.3, // cubic ft per scoop (~2.2 gallons)
    bailInterval: 1.1, // seconds between scoops
    waterDensity: 64, // lbs/ft³ (saltwater)
    ingressCoefficient: 1.8, // cubic ft/s per ft of submersion
    sloshGravity: 4.0,
    sloshDamping: 2.0,
    halfBeam: 2.8, // ft — half of 5.6ft beam at deck edge
    sinkingDuration: 3.0, // seconds
  },

  hullDamage: {
    groundingDamageRate: 0.15, // moderate damage rate
    groundingSpeedThreshold: 1.0, // ft/s — gentle bumps are safe
    damageFrictionMultiplier: 2.0, // at 0 health, Cf triples (0.003 → 0.009)
    damageLeakRate: 0.5, // cubic ft/s at 0 health
    repairRate: 0, // no self-repair
  },

  rudderDamage: {
    groundingDamageRate: 0.25, // rudder is more fragile than hull
    groundingSpeedThreshold: 0.8, // ft/s
    maxSteeringReduction: 0.7, // lose 70% of steering authority at 0 health
    maxSteeringBias: 0.3, // pulls 30% toward one side at 0 health
    repairRate: 0, // no self-repair
  },

  sailDamage: {
    overpowerForceThreshold: 400, // lbf — sail load above this causes wear
    overpowerDamageRate: 0.00005, // damage per excess lbf per second
    jibeDamagePerForce: 0.00008, // damage per lbf of boom slam force
    maxLiftReduction: 0.6, // lose 60% of drive force at 0 health
    repairRate: 0, // no self-repair
  },

  // Tilt parameters derived from hull geometry and assumed ~450 lb displacement
  // (250 lb hull + ~170 lb crew + equipment).
  // Narrower beam (5.6 ft) → less form stability (GM ≈ 2.5 ft).
  tilt: {
    rollInertia: 1600, // 450 * (beam/3)² = 450 * 1.87²
    pitchInertia: 4000, // 450 * (LOA/4)² = 450 * 3²
    rollDamping: 3000, // ζ=0.2, critically damped = 2*sqrt(1600*36000)
    pitchDamping: 6000, // ζ=0.2, critically damped = 2*sqrt(4000*58000)
    rightingMomentCoeff: 36000, // 450 * 32.174 * GM_roll(2.5 ft)
    pitchRightingCoeff: 58000, // 450 * 32.174 * GM_pitch(4 ft)
    maxRoll: degToRad(90),
    maxPitch: degToRad(60),
    waveRollCoeff: 600,
    wavePitchCoeff: 600,
    zHeights: {
      deck: 0.8,
      boom: 2.5,
      mastTop: 16,
      keel: -3.0,
      rudder: -1.0,
      bowsprit: 0.4,
    },
  },
};
