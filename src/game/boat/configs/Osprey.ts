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
    // 2D collision polygon (deck outline, CCW winding)
    vertices: [
      V(-11.5, -1.8),
      V(-11.0, -3.0),
      V(-5, -4.375),
      V(1, -4.375),
      V(7, -3.4),
      V(11.5, -1.8),
      V(14.75, 0),
      V(11.5, 1.8),
      V(7, 3.4),
      V(1, 4.375),
      V(-5, 4.375),
      V(-11.0, 3.0),
      V(-11.5, 1.8),
    ], // ~26.25 ft LOA, ~8.75 ft beam
    // 3D hull shape — station profiles from stern to bow.
    // Each profile is a half-curve [y, z] from keel center to gunwale (starboard).
    shape: {
      stations: [
        // Stern transom — narrow, relatively flat
        {
          x: -11.5,
          profile: [
            [0, -0.6],
            [0.55, -0.6],
            [1.4, 0],
            [1.8, 3.0],
          ],
        },
        // Stern shoulder — widening aft sections
        {
          x: -11.0,
          profile: [
            [0, -1.0],
            [1.0, -1.0],
            [2.4, 0],
            [3.0, 3.0],
          ],
        },
        // Aft quarter — approaching max beam
        {
          x: -5,
          profile: [
            [0, -1.2],
            [1.5, -1.2],
            [3.6, 0],
            [4.375, 3.0],
          ],
        },
        // Midships — max beam, deepest draft
        {
          x: 1,
          profile: [
            [0, -1.2],
            [1.5, -1.2],
            [3.6, 0],
            [4.375, 3.0],
          ],
        },
        // Forward quarter — narrowing
        {
          x: 7,
          profile: [
            [0, -1.2],
            [1.2, -1.2],
            [2.8, 0],
            [3.4, 3.0],
          ],
        },
        // Forward shoulder — fine entry
        {
          x: 11.5,
          profile: [
            [0, -0.8],
            [0.55, -0.6],
            [1.4, 0],
            [1.8, 3.0],
          ],
        },
        // Bow — collapses to a point
        {
          x: 14.75,
          profile: [
            [0, -0.3],
            [0, 3.0],
          ],
        },
      ],
      sharpStations: [6], // bow
    },
    // Deck plan — interior layout
    deckPlan: {
      zones: [
        // Foredeck — flat deck forward of bulkhead
        {
          name: "foredeck",
          type: "deck",
          outline: [
            [3, -6],
            [3, 6],
            [15, 6],
            [15, -6],
          ],
          floorZ: 3.0,
          color: 0xb8935a,
        },
        // Cockpit sole — recessed floor (oversized, clipped to hull outline)
        {
          name: "cockpit",
          type: "cockpit",
          outline: [
            [-12, -6],
            [-12, 6],
            [3, 6],
            [3, -6],
          ],
          floorZ: 1.2,
          color: 0x7a5a35,
        },
        // Port bench — extends from stern to bulkhead
        {
          name: "port-bench",
          type: "bench",
          outline: [
            [-11, 2.0],
            [-11, 6],
            [3, 6],
            [3, 2.0],
          ],
          floorZ: 2.0,
          color: 0xa58048,
        },
        // Starboard bench
        {
          name: "starboard-bench",
          type: "bench",
          outline: [
            [-11, -6],
            [-11, -2.0],
            [3, -2.0],
            [3, -6],
          ],
          floorZ: 2.0,
          color: 0xa58048,
        },
        // Port bulkhead — forward cockpit wall (port side of companionway)
        {
          name: "port-bulkhead",
          type: "deck",
          outline: [
            [3, 1.0],
            [3, 6],
            [3.5, 6],
            [3.5, 1.0],
          ],
          floorZ: 1.2,
          wallHeight: 1.8,
          color: 0x7a5530,
          wallColor: 0x7a5530,
        },
        // Starboard bulkhead — forward cockpit wall (starboard side of companionway)
        {
          name: "starboard-bulkhead",
          type: "deck",
          outline: [
            [3, -6],
            [3, -1.0],
            [3.5, -1.0],
            [3.5, -6],
          ],
          floorZ: 1.2,
          wallHeight: 1.8,
          color: 0x7a5530,
          wallColor: 0x7a5530,
        },
        // Companionway — dark opening between cockpit and cabin
        {
          name: "companionway",
          type: "companionway",
          outline: [
            [3, -1.0],
            [3, 1.0],
            [3.5, 1.0],
            [3.5, -1.0],
          ],
          floorZ: 1.2,
          color: 0x3a2810,
        },
      ],
    },
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
      [7, 3.25], // on hull edge at forward quarter
      [1, 4.225], // at max beam
      [-5, 4.225], // at max beam, aft
      [-9, 3.05], // aft quarter, interpolated toward stern
    ],
    starboardStanchions: [
      [7, -3.25],
      [1, -4.225],
      [-5, -4.225],
      [-9, -3.05],
    ],
    bowPulpit: [
      [10, -2.4],
      [13, -1.1],
      [14.75, 0],
      [13, 1.1],
      [10, 2.4],
    ],
    sternPulpit: [
      [-10.85, -2.77],
      [-11.35, -1.57],
      [-11.35, 0],
      [-11.35, 1.57],
      [-10.85, 2.77],
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
    anchorMass: 25, // lbs
    deckHeight: 3.0,
    rollInertia: 0.8,
    pitchInertia: 4.0,
    yawInertia: 4.0,
    rodeAttachOffset: [1.28, 0, 0.45] as const,
    anchorDragCoefficient: 800,
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
    ropeThickness: 0.35,
  },

  jibSheet: {
    portAttachPoint: V(-7, 4.0),
    starboardAttachPoint: V(-7, -4.0),
    minLength: 7,
    maxLength: 20,
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
