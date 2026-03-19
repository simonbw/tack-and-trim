import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Starter Dinghy - A typical 16ft sailing dinghy
 * Good all-around boat for learning and casual sailing.
 */
export const StarterDinghy: BoatConfig = {
  hull: {
    mass: 200, // lbs
    vertices: [
      // Stern (transom)
      V(-6.5, -1.3),
      V(-6, -2.3),
      // Starboard side
      V(-2.5, -3.3),
      V(2, -3.3),
      V(5.3, -2.6),
      V(8, -1.3),
      // Bow
      V(9.2, 0),
      // Port side
      V(8, 1.3),
      V(5.3, 2.6),
      V(2, 3.3),
      V(-2.5, 3.3),
      V(-6, 2.3),
      V(-6.5, 1.3),
    ], // ~16 ft LOA, ~6.6 ft beam
    waterlineVertices: [
      // Narrower shape at the waterline (below gunwales/flare)
      // Stern (transom)
      V(-6.3, -1.0),
      V(-5.8, -1.8),
      // Starboard side
      V(-2.5, -2.6),
      V(2, -2.6),
      V(5.3, -2.0),
      V(7.8, -1.0),
      // Bow
      V(8.8, 0),
      // Port side
      V(7.8, 1.0),
      V(5.3, 2.0),
      V(2, 2.6),
      V(-2.5, 2.6),
      V(-5.8, 1.8),
      V(-6.3, 1.0),
    ], // ~15.1 ft WLL, ~5.2 ft waterline beam
    bottomVertices: [
      // Narrowest cross-section at hull bottom (keel line area)
      // Stern
      V(-6.1, -0.45),
      V(-5.5, -0.8),
      // Starboard side
      V(-2.5, -1.2),
      V(2, -1.2),
      V(5.3, -0.9),
      V(7.5, -0.45),
      // Bow
      V(8.5, 0),
      // Port side
      V(7.5, 0.45),
      V(5.3, 0.9),
      V(2, 1.2),
      V(-2.5, 1.2),
      V(-5.5, 0.8),
      V(-6.1, 0.45),
    ], // ~14.6 ft, ~2.4 ft bottom beam
    skinFrictionCoefficient: 0.003, // Typical smooth hull skin friction
    draft: 0.8, // ft below waterline (hull bottom)
    deckHeight: 2.0, // ft above waterline (gunwale freeboard)
    colors: {
      fill: 0xccaa33,
      stroke: 0x886633,
      side: 0xbb9928, // hull topsides, slightly darker than deck
      bottom: 0x886633, // same as deck outline
    },
  },

  keel: {
    vertices: [V(-5, 0), V(5, 0)], // 10ft span centerboard
    draft: 3.5, // ft below waterline (centerboard extends 3ft below hull)
    color: 0x4a3a3d, // match rudder color
  },

  rudder: {
    position: V(-6, 0), // At transom
    length: 2.5, // ft (span of rudder blade)
    draft: 2.5, // ft below waterline (rudder tip)
    maxSteerAngle: degToRad(35),
    steerAdjustSpeed: 0.8, // rad/sec
    steerAdjustSpeedFast: 2.0, // rad/sec
    color: 0x4a3a3d, // Dark brown with bluish tint for underwater rudder
  },

  rig: {
    mastPosition: V(3, 0), // ~35-40% from bow
    boomLength: 1, // ft
    boomWidth: 0.5, // ft (~6 inches)
    boomMass: 15, // lbs
    colors: {
      mast: 0x4a3a3d, // match keel/rudder
      boom: 0x997744,
    },
    mainsail: {
      nodeCount: 32,
      nodeMass: 0.7, // heavier for better force transfer through constraints
      slackFactor: 1.005, // 0.5% slack
      liftScale: 5.0,
      dragScale: 5.0,
      billowInner: 0.8,
      billowOuter: 2.4,
      windInfluenceRadius: 15, // ft
      hoistSpeed: 0.4,
      color: 0xeeeeff,
    },
    stays: {
      forestay: V(10, 0), // just aft of bowsprit tip
      portShroud: V(2, 3),
      starboardShroud: V(2, -3),
      backstay: V(-6, 0),
      deckHeight: 2.0,
    },
  },

  bowsprit: {
    attachPoint: V(9, 0),
    size: V(2, 0.4), // ft (length, width)
    color: 0x775533,
  },

  anchor: {
    bowAttachPoint: V(9.2, 0),
    maxRodeLength: 40, // ft
    anchorSize: 1, // ft (visual radius)
    rodeDeploySpeed: 20, // ft/s
    rodeRetrieveSpeed: 12, // ft/s
    anchorMass: 30, // lbs
    anchorDragCoefficient: 300,
  },

  jib: {
    nodeCount: 32,
    nodeMass: 0.5, // heavier for better force transfer through constraints
    slackFactor: 1.005,
    liftScale: 5.0,
    dragScale: 5.0,
    billowOuter: 1.5,
    windInfluenceRadius: 15, // ft
    hoistSpeed: 0.4,
    color: 0xeeeeff,
  },

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-5, 0), // ft from hull center (cockpit floor)
    minLength: 2, // ft
    maxLength: 10, // ft
    defaultLength: 5, // ft
    trimSpeed: 3, // ft/s
    easeSpeed: 3, // ft/s
    ropeThickness: 0.3,
  },

  jibSheet: {
    portAttachPoint: V(-3, 2.5), // cockpit, port side
    starboardAttachPoint: V(-3, -2.5), // cockpit, starboard side
    minLength: 5, // ft
    maxLength: 15, // ft
    defaultLength: 10, // ft
    trimSpeed: 6, // ft/s
    easeSpeed: 18, // ft/s
    ropeThickness: 0.3,
  },

  rowing: {
    duration: 0.6, // seconds
    force: 5000, // lbf
  },

  grounding: {
    keelFriction: 500, // lbf per ft penetration per ft/s - centerboard hits first
    rudderFriction: 300, // lbf per ft penetration per ft/s
    hullFriction: 2000, // lbf per ft penetration per ft/s - severe when hull grounds
  },

  tilt: {
    rollInertia: 800,
    pitchInertia: 1500,
    rollDamping: 1200,
    pitchDamping: 2000,
    rightingMomentCoeff: 5000,
    pitchRightingCoeff: 12000,
    maxRoll: degToRad(60),
    maxPitch: degToRad(30),
    waveRollCoeff: 500,
    wavePitchCoeff: 500,
    zHeights: {
      deck: 1, // ft above waterline
      boom: 3,
      sailCE: 8,
      mastTop: 20,
      keel: -3.5,
      rudder: -1.25,
      bowsprit: 0.5,
    },
  },
};
