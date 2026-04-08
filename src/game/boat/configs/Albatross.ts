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
    // 3D hull shape — station profiles from stern to bow.
    // Each profile is a half-curve [y, z] from keel center to gunwale (starboard).
    shape: {
      stations: [
        // Stern transom — narrow, shallow
        {
          x: -17,
          profile: [
            [0, -0.8],
            [0.8, -0.8],
            [2.0, 0],
            [2.5, 4.0],
          ],
        },
        // Stern shoulder — widening aft sections
        {
          x: -16.5,
          profile: [
            [0, -1.4],
            [1.5, -1.4],
            [3.6, 0],
            [4.5, 4.0],
          ],
        },
        // Aft quarter — approaching max beam
        {
          x: -8,
          profile: [
            [0, -1.8],
            [2.2, -1.8],
            [5.2, 0],
            [6.25, 4.0],
          ],
        },
        // Midships — max beam, deepest draft
        {
          x: 0,
          profile: [
            [0, -1.8],
            [2.2, -1.8],
            [5.2, 0],
            [6.25, 4.0],
          ],
        },
        // Forward quarter — narrowing
        {
          x: 9,
          profile: [
            [0, -1.8],
            [1.7, -1.8],
            [4.1, 0],
            [5.0, 4.0],
          ],
        },
        // Forward shoulder — fine entry
        {
          x: 17,
          profile: [
            [0, -1.4],
            [0.8, -1.2],
            [2.0, 0],
            [2.5, 4.0],
          ],
        },
        // Bow — collapses to a point
        {
          x: 23.4,
          profile: [
            [0, -0.5],
            [0, 4.0],
          ],
        },
      ],
      sharpStations: [6], // bow
    },
    // Deck plan — interior layout for a 40ft performance cruiser
    deckPlan: {
      zones: [
        // Foredeck — flat deck forward of cabin
        {
          name: "foredeck",
          type: "deck",
          outline: [
            [5, -8],
            [5, 8],
            [24, 8],
            [24, -8],
          ],
          floorZ: 4.0,
          color: 0xa07848,
        },
        // Cabin trunk — raised cabin top
        {
          name: "cabin-trunk",
          type: "cabin",
          outline: [
            [-2, -8],
            [-2, 8],
            [5, 8],
            [5, -8],
          ],
          floorZ: 4.0,
          wallHeight: 1.5,
          color: 0x7a5830,
          wallColor: 0x7a5830,
        },
        // Cabin sole — interior floor visible through companionway
        {
          name: "cabin-sole",
          type: "sole",
          outline: [
            [-2, -8],
            [-2, 8],
            [5, 8],
            [5, -8],
          ],
          floorZ: 1.5,
          color: 0x4a3018,
        },
        // Cockpit sole — recessed floor
        {
          name: "cockpit",
          type: "cockpit",
          outline: [
            [-18, -8],
            [-18, 8],
            [-2, 8],
            [-2, -8],
          ],
          floorZ: 1.5,
          color: 0x6a4828,
        },
        // Port bench
        {
          name: "port-bench",
          type: "bench",
          outline: [
            [-15, 2.5],
            [-15, 8],
            [-2, 8],
            [-2, 2.5],
          ],
          floorZ: 2.5,
          color: 0x906838,
        },
        // Starboard bench
        {
          name: "starboard-bench",
          type: "bench",
          outline: [
            [-15, -8],
            [-15, -2.5],
            [-2, -2.5],
            [-2, -8],
          ],
          floorZ: 2.5,
          color: 0x906838,
        },
        // Port bulkhead — forward cockpit wall (port side of companionway)
        {
          name: "port-bulkhead",
          type: "deck",
          outline: [
            [-2, 1.2],
            [-2, 8],
            [-1.5, 8],
            [-1.5, 1.2],
          ],
          floorZ: 1.5,
          wallHeight: 2.5,
          color: 0x6a4828,
          wallColor: 0x6a4828,
        },
        // Starboard bulkhead — forward cockpit wall (starboard side of companionway)
        {
          name: "starboard-bulkhead",
          type: "deck",
          outline: [
            [-2, -8],
            [-2, -1.2],
            [-1.5, -1.2],
            [-1.5, -8],
          ],
          floorZ: 1.5,
          wallHeight: 2.5,
          color: 0x6a4828,
          wallColor: 0x6a4828,
        },
        // Companionway — dark opening between cockpit and cabin
        {
          name: "companionway",
          type: "companionway",
          outline: [
            [-2, -1.2],
            [-2, 1.2],
            [-1.5, 1.2],
            [-1.5, -1.2],
          ],
          floorZ: 1.5,
          color: 0x2a1808,
        },
      ],
    },
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
      [13, 3.65], // forward, interpolated between V(17,2.5) and V(9,5.0)
      [9, 4.85], // on hull vertex
      [4.5, 5.45], // between V(9,5.0) and V(0,6.25)
      [0, 6.1], // at max beam
      [-8, 6.1], // on hull vertex
      [-13, 5.15], // aft, interpolated toward stern
    ],
    starboardStanchions: [
      [13, -3.65],
      [9, -4.85],
      [4.5, -5.45],
      [0, -6.1],
      [-8, -6.1],
      [-13, -5.15],
    ],
    bowPulpit: [
      [15.5, -3.2],
      [20, -1.7],
      [23.4, 0],
      [20, 1.7],
      [15.5, 3.2],
    ],
    sternPulpit: [
      [-16.35, -4.27],
      [-16.85, -2.27],
      [-16.85, 0],
      [-16.85, 2.27],
      [-16.35, 4.27],
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
    anchorMass: 45, // lbs
    deckHeight: 4.0,
    rollInertia: 2.0,
    pitchInertia: 10.0,
    yawInertia: 10.0,
    rodeAttachOffset: [1.71, 0, 0.6] as const,
    anchorDragCoefficient: 1500,
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
    ropeThickness: 0.4,
  },

  jibSheet: {
    portAttachPoint: V(-12, 5.5),
    starboardAttachPoint: V(-12, -5.5),
    minLength: 10,
    maxLength: 28,
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
