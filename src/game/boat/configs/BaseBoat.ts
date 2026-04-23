import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Baseline 22ft keelboat config. Every concrete boat derives from this
 * via `scaleBoatConfig` (geometry), `withBrandPalette` (colors), and
 * `createBoatConfig` (per-boat physics overrides). Not shipped as a
 * playable boat itself — it exists purely as the reference hull.
 *
 * Dimensions loosely follow the J/22 (LOA 22.5ft, disp 1790 lbs).
 */
export const BaseBoat: BoatConfig = {
  hull: {
    mass: 900, // lbs - structural mass for 2D physics
    // 2D collision polygon (deck outline, CCW winding)
    vertices: [
      V(-9.5, -1.5),
      V(-9.0, -2.7),
      V(-4, -4.0),
      V(1, -4.0),
      V(6, -3.0),
      V(10, -1.5),
      V(13, 0),
      V(10, 1.5),
      V(6, 3.0),
      V(1, 4.0),
      V(-4, 4.0),
      V(-9.0, 2.7),
      V(-9.5, 1.5),
    ],
    // 3D hull shape — station profiles from stern to bow.
    // Each profile is a half-curve [y, z] from keel center to gunwale (starboard).
    shape: {
      stations: [
        // Stern transom — narrow, relatively flat
        {
          x: -9.5,
          profile: [
            [0, -0.5],
            [0.5, -0.5],
            [1.15, 0],
            [1.5, 2.5],
          ],
        },
        // Stern shoulder — widening aft sections
        {
          x: -9.0,
          profile: [
            [0, -0.8],
            [0.9, -0.8],
            [2.1, 0],
            [2.7, 2.5],
          ],
        },
        // Aft quarter — approaching max beam
        {
          x: -4,
          profile: [
            [0, -1.0],
            [1.4, -1.0],
            [3.3, 0],
            [4.0, 2.5],
          ],
        },
        // Midships — max beam, deepest draft
        {
          x: 1,
          profile: [
            [0, -1.0],
            [1.4, -1.0],
            [3.3, 0],
            [4.0, 2.5],
          ],
        },
        // Forward quarter — narrowing
        {
          x: 6,
          profile: [
            [0, -1.0],
            [1.1, -1.0],
            [2.5, 0],
            [3.0, 2.5],
          ],
        },
        // Forward shoulder — fine entry
        {
          x: 10,
          profile: [
            [0, -0.8],
            [0.5, -0.6],
            [1.15, 0],
            [1.5, 2.5],
          ],
        },
        // Bow — collapses to a point
        {
          x: 13,
          profile: [
            [0, -0.3],
            [0, 2.5],
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
            [2.0, -5],
            [2.0, 5],
            [14, 5],
            [14, -5],
          ],
          floorZ: 2.5,
          color: 0xc4a46c,
        },
        // Cockpit sole — recessed floor (oversized, clipped to hull outline)
        {
          name: "cockpit",
          type: "cockpit",
          outline: [
            [-10, -5],
            [-10, 5],
            [2.0, 5],
            [2.0, -5],
          ],
          floorZ: 1.0,
          color: 0x7d6040,
        },
        // Port bench — extends from stern to bulkhead
        {
          name: "port-bench",
          type: "bench",
          outline: [
            [-10, 1.8],
            [-10, 5],
            [2.0, 5],
            [2.0, 1.8],
          ],
          floorZ: 1.8,
          color: 0xb09050,
        },
        // Starboard bench
        {
          name: "starboard-bench",
          type: "bench",
          outline: [
            [-10, -5],
            [-10, -1.8],
            [2.0, -1.8],
            [2.0, -5],
          ],
          floorZ: 1.8,
          color: 0xb09050,
        },
        // Port bulkhead — forward cockpit wall (port side of companionway)
        {
          name: "port-bulkhead",
          type: "deck",
          outline: [
            [2.0, 0.9],
            [2.0, 5],
            [2.5, 5],
            [2.5, 0.9],
          ],
          floorZ: 1.0,
          wallHeight: 1.5,
          color: 0x8a6a3c,
          wallColor: 0x8a6a3c,
        },
        // Starboard bulkhead — forward cockpit wall (starboard side of companionway)
        {
          name: "starboard-bulkhead",
          type: "deck",
          outline: [
            [2.0, -5],
            [2.0, -0.9],
            [2.5, -0.9],
            [2.5, -5],
          ],
          floorZ: 1.0,
          wallHeight: 1.5,
          color: 0x8a6a3c,
          wallColor: 0x8a6a3c,
        },
        // Companionway — dark opening between cockpit and cabin
        {
          name: "companionway",
          type: "companionway",
          outline: [
            [2.0, -0.9],
            [2.0, 0.9],
            [2.5, 0.9],
            [2.5, -0.9],
          ],
          floorZ: 1.0,
          color: 0x3a2810,
        },
      ],
    },
    skinFrictionCoefficient: 0.003,
    stagnationCoefficient: 0.4, // placeholder until precomputed separation model (#125)
    separationCoefficient: 0.12, // placeholder until precomputed separation model (#125)
    draft: 1.0, // ft below waterline (hull bottom)
    deckHeight: 2.5, // ft above waterline (gunwale freeboard)
    colors: {
      fill: 0xc4a46c, // light teak deck
      stroke: 0x7a5230, // dark wood trim
      side: 0xc4a46c,
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
    position: V(-9.75, 0), // Behind transom (stock hangs off stern)
    length: 2.5, // ft
    draft: 3.0, // ft below waterline
    chord: 2.0, // ft
    maxSteerAngle: degToRad(60),
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
      backstay: {
        split: V(-9.0, 0),
        splitZ: 5.0,
        port: V(-9.2, 2.3),
        starboard: V(-9.2, -2.3),
      },
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
    anchorMass: 15, // lbs
    deckHeight: 2.5,
    rollInertia: 0.3,
    pitchInertia: 1.5,
    yawInertia: 1.5,
    rodeAttachOffset: [1.02, 0, 0.36] as const,
    anchorDragCoefficient: 500,
    ropePattern: {
      type: "braid",
      carriers: [
        0x22aa44, 0x22aa44, 0xddaa00, 0xddaa00, 0x22aa44, 0x22aa44, 0x22aa44,
        0x22aa44,
      ],
      helixAngle: 40,
    },
  },

  jib: {
    nodeMass: 0.6,
    liftScale: 1.0,
    dragScale: 1.0,
    hoistSpeed: 0.4,
    color: 0xeeeeff,
    zFoot: 4.0, // top of bowsprit roller drum
    zHead: 26, // masthead — matches mainsail.zHead so the head meets the forestay top
  },

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-7.5, 0), // cleat — aft end of cockpit sole
    winchPoint: V(-6.5, 0), // cam cleat on cockpit sole
    minLength: 2,
    maxLength: 12,
    ropeThickness: 0.15,
    ropeColor: 0xeeeeee,
    // White base with a single navy fleck (symmetric 16-plait)
    ropePattern: {
      type: "braid",
      carriers: [
        0xeeeeee, 0xeeeeee, 0x113366, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee,
        0xeeeeee, 0xeeeeee, 0xeeeeee, 0x113366, 0xeeeeee, 0xeeeeee, 0xeeeeee,
        0xeeeeee, 0xeeeeee,
      ],
      helixAngle: 35,
    },
  },

  jibSheet: {
    portAttachPoint: V(-6, 2.6), // cleat — tail end, cockpit coaming
    starboardAttachPoint: V(-6, -2.6),
    portBlockPoint: V(3, 3.0), // deck block, forward of bulkhead
    starboardBlockPoint: V(3, -3.0),
    blockFrictionCoefficient: 0.4,
    portWinchPoint: V(-4, 2.8), // winch on cockpit coaming
    starboardWinchPoint: V(-4, -2.8),
    minLength: 6,
    maxLength: 18,
    ropeThickness: 0.15,
    ropeColor: 0x113366,
    // Navy base with a single white fleck (symmetric 16-plait)
    ropePattern: {
      type: "braid",
      carriers: [
        0x113366, 0x113366, 0xeeeeee, 0x113366, 0x113366, 0x113366, 0x113366,
        0x113366, 0x113366, 0x113366, 0xeeeeee, 0x113366, 0x113366, 0x113366,
        0x113366, 0x113366,
      ],
      helixAngle: 35,
    },
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
    bailBucketSize: 0.4,
    bailInterval: 1.0,
    waterDensity: 64, // lbs/ft³ (saltwater)
    sloshFreqLateral: 4.0,
    sloshFreqLongitudinal: 2.2,
    sloshDampingRatio: 0.4,
    sinkingDuration: 15.0,
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

  // Sailor station layout
  initialStationId: "helm",
  stations: [
    {
      id: "helm",
      name: "Helm",
      position: [-8, 0], // aft cockpit, near tiller
      steerAxis: "rudder",
      primaryAxis: "mainsheet",
      secondaryAxis: "jibSheets",
    },
    {
      id: "mast",
      name: "Mast",
      position: [5, 0], // at base of mast
      primaryAxis: "mainHoist",
      actions: ["bail"],
    },
    {
      id: "bow",
      name: "Bow",
      position: [11, 0], // foredeck near bow roller
      primaryAxis: "jibHoistFurl",
      actions: ["anchor", "mooring"],
    },
  ],

  // Tilt parameters derived from hull geometry and ~2100 lb displacement
  // (900 lb hull + 600 lb keel ballast + ~600 lb crew/rigging/sails/supplies).
  // GM_roll ≈ 3.0 ft (swing keel, moderate form stability).
  tilt: {
    rollInertia: 14933, // 2100 * (8/3)² = 2100 * 7.11
    pitchInertia: 66445, // 2100 * (22.5/4)² = 2100 * 31.64
    rollDamping: 22007, // 0.4 * sqrt(14933 * 202696)
    pitchDamping: 56854, // 0.4 * sqrt(66445 * 304044)
    rightingMomentCoeff: 202696, // 2100 * 32.174 * 3.0
    pitchRightingCoeff: 304044, // 2100 * 32.174 * 4.5
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
    verticalMass: 2100, // total displacement
    rollInertia: 14933,
    pitchInertia: 66445,
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
