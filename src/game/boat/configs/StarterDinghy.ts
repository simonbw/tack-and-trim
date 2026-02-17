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
    skinFrictionCoefficient: 0.003, // Typical smooth hull skin friction
    draft: 0.5, // ft below waterline (hull bottom)
    colors: {
      fill: 0xccaa33,
      stroke: 0x886633,
    },
  },

  keel: {
    vertices: [V(-5, 0), V(5, 0)], // 10ft span centerboard
    draft: 3.5, // ft below waterline (centerboard extends 3ft below hull)
    color: 0x665522,
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
    boomLength: 7, // ft
    boomWidth: 0.5, // ft (~6 inches)
    boomMass: 15, // lbs
    colors: {
      mast: 0x886633,
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
};
