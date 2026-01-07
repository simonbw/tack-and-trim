import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Starter Dinghy - A typical 16ft sailing dinghy
 * Good all-around boat for learning and casual sailing.
 */
export const StarterDinghy: BoatConfig = {
  hull: {
    mass: 350, // lbs - typical 16ft dinghy displacement
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
    liftAndDrag: 0.15,
    skinFrictionCoefficient: 0.02,
    colors: {
      fill: 0xccaa33,
      stroke: 0x886633,
    },
  },

  keel: {
    vertices: [V(-5, 0), V(5, 0)], // 10ft span across hull bottom
    liftAndDrag: 1.5,
    color: 0x665522,
  },

  rudder: {
    position: V(-2, 0), // Near stern
    length: 3, // ft
    liftAndDrag: 2.0,
    maxSteerAngle: degToRad(35),
    steerAdjustSpeed: 0.8, // rad/sec
    steerAdjustSpeedFast: 2.0, // rad/sec
    color: 0x665599,
  },

  rig: {
    mastPosition: V(1.5, 0),
    boomLength: 8, // ft
    boomWidth: 0.5, // ft (~6 inches)
    boomMass: 15, // lbs
    colors: {
      mast: 0x886633,
      boom: 0x997744,
    },
    mainsail: {
      nodeCount: 32,
      nodeMass: 0.04, // lbs per particle
      slackFactor: 1.01, // 1% slack
      liftScale: 2.0,
      dragScale: 2.0,
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
    bowAttachPoint: V(8.5, 0),
    maxRodeLength: 100, // ft
    anchorSize: 1, // ft (visual radius)
    rodeDeploySpeed: 6, // ft/s
    rodeRetrieveSpeed: 3, // ft/s
    anchorMass: 15, // lbs
    anchorDragCoefficient: 200,
  },

  jib: {
    nodeCount: 32,
    nodeMass: 0.04, // lbs per particle
    slackFactor: 1.01,
    liftScale: 2.0,
    dragScale: 2.0,
    billowOuter: 1.5,
    windInfluenceRadius: 15, // ft
    hoistSpeed: 0.4,
    color: 0xeeeeff,
  },

  mainsheet: {
    boomAttachRatio: 0.9,
    hullAttachPoint: V(-4, 0), // ft from hull center (stern area)
    minLength: 2, // ft
    maxLength: 12, // ft
    defaultLength: 7, // ft
    trimSpeed: 3, // ft/s
    easeSpeed: 3, // ft/s
  },

  jibSheet: {
    portAttachPoint: V(-1.5, 3), // ft from hull center
    starboardAttachPoint: V(-1.5, -3), // ft from hull center
    minLength: 3, // ft
    maxLength: 13, // ft
    defaultLength: 8, // ft
    trimSpeed: 6, // ft/s
    easeSpeed: 18, // ft/s
  },

  rowing: {
    duration: 0.6, // seconds
    force: 5000, // lbf
  },
};
