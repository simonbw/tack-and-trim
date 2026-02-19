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
    skinFrictionCoefficient: 0.003,
    draft: 0.4, // ft below waterline
    colors: {
      fill: 0xccaa33,
      stroke: 0x886633,
    },
  },

  keel: {
    vertices: [V(-4.2, 0), V(4.2, 0)], // 8.4ft span centerboard
    draft: 3.0, // ft below waterline
    color: 0x665522,
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
      mast: 0x886633,
      boom: 0x997744,
    },
    mainsail: {
      nodeCount: 28,
      nodeMass: 0.8, // heavier for better force transfer through constraints
      slackFactor: 1.005,
      liftScale: 5.0,
      dragScale: 5.0,
      billowInner: 0.7,
      billowOuter: 2.2,
      windInfluenceRadius: 12, // ft
      hoistSpeed: 0.4,
      color: 0xeeeeff,
    },
  },

  bowsprit: {
    attachPoint: V(7.6, 0),
    size: V(1.0, 0.3), // ft - smaller bowsprit (decorative, no jib)
    color: 0x775533,
  },

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
    minLength: 2,
    maxLength: 9,
    defaultLength: 4.5,
    trimSpeed: 3,
    easeSpeed: 3,
    ropeThickness: 0.3,
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
};
