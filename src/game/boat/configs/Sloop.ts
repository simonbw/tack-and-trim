import { degToRad } from "../../../core/util/MathUtil";
import { V } from "../../../core/Vector";
import { BoatConfig } from "../BoatConfig";

/**
 * Sloop - A 16ft sailing dinghy with mainsail and jib
 * More advanced boat with better upwind performance.
 */
export const Sloop: BoatConfig = {
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
    skinFrictionCoefficient: 0.003, // Typical smooth hull skin friction
    colors: {
      fill: 0xccaa33,
      stroke: 0x886633,
    },
  },

  keel: {
    vertices: [V(-5, 0), V(5, 0)], // 10ft span centerboard
    color: 0x665522,
  },

  rudder: {
    position: V(-6, 0), // At transom
    length: 2.5, // ft (span of rudder blade)
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
    bowAttachPoint: V(9.2, 0),
    maxRodeLength: 40, // ft
    anchorSize: 1, // ft (visual radius)
    rodeDeploySpeed: 8, // ft/s
    rodeRetrieveSpeed: 4, // ft/s
    anchorMass: 30, // lbs
    anchorDragCoefficient: 300,
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
};
