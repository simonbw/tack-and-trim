import { DeepPartial, deepMerge } from "../../core/util/ObjectUtils";
import { V2d } from "../../core/Vector";
import { StarterDinghy } from "./configs/StarterDinghy";
import { SailConfig } from "./sail/Sail";
import { SheetConfig } from "./Sheet";

// ============================================
// Component Config Interfaces
// ============================================

export interface HullConfig {
  readonly mass: number; // lbs
  readonly vertices: V2d[]; // ft, deck/gunwale polygon, counter-clockwise winding (visual/collision)
  readonly waterlineVertices?: V2d[]; // ft, narrower shape at the waterline (water interaction)
  readonly bottomVertices?: V2d[]; // ft, hull bottom shape (narrowest, at z = -draft)
  readonly skinFrictionCoefficient: number; // dimensionless Cf (typically 0.003-0.004)
  readonly draft: number; // ft below waterline (hull bottom)
  readonly deckHeight: number; // ft above waterline (gunwale/deck edge)
  readonly colors: {
    readonly fill: number; // deck color
    readonly stroke: number; // outline color
    readonly side?: number; // hull topsides color (between deck and waterline)
    readonly bottom?: number; // hull bottom color (below waterline, antifouling)
  };
}

export interface KeelConfig {
  readonly vertices: V2d[]; // ft, keel shape (usually a line)
  readonly draft: number; // ft below waterline (tip of keel/centerboard)
  readonly color: number;
}

export interface RudderConfig {
  readonly position: V2d; // ft from hull center
  readonly length: number; // ft (span of rudder blade)
  readonly draft: number; // ft below waterline (tip of rudder)
  readonly maxSteerAngle: number; // radians
  readonly steerAdjustSpeed: number; // rad/sec
  readonly steerAdjustSpeedFast: number; // rad/sec
  readonly color: number;
}

export interface GroundingConfig {
  readonly keelFriction: number; // lbf per ft penetration per ft/s
  readonly rudderFriction: number; // lbf per ft penetration per ft/s
  readonly hullFriction: number; // lbf per ft penetration per ft/s (higher - hull grounding is severe)
}

// Sail physics properties configurable per-boat (optional, defaults in Sail.ts)
export type BaseSailConfig = Partial<
  Pick<
    SailConfig,
    | "nodeMass"
    | "liftScale"
    | "dragScale"
    | "hoistSpeed"
    | "color"
    | "clothColumns"
    | "clothRows"
    | "clothDamping"
    | "clothIterations"
    | "bendStiffness"
    | "zFoot"
    | "zHead"
  >
>;

export interface MainsailConfig extends BaseSailConfig {}

export interface RigConfig {
  readonly mastPosition: V2d; // ft from hull center
  readonly boomLength: number; // ft
  readonly boomWidth: number; // ft
  readonly boomMass: number; // lbs
  readonly colors: {
    readonly mast: number;
    readonly boom: number;
  };
  readonly mainsail: MainsailConfig;
  readonly stays: {
    readonly forestay: V2d; // hull-local attachment point for forestay
    readonly portShroud: V2d; // hull-local attachment point for port shroud
    readonly starboardShroud: V2d; // hull-local attachment point for starboard shroud
    readonly backstay: V2d; // hull-local attachment point for backstay
    readonly deckHeight: number; // z-height of deck attachment points (ft above waterline)
  };
}

export interface BowspritConfig {
  readonly attachPoint: V2d; // ft from hull center
  readonly size: V2d; // ft (length, width)
  readonly color: number;
}

export interface AnchorConfig {
  readonly bowAttachPoint: V2d; // ft from hull center
  readonly maxRodeLength: number; // ft
  readonly anchorSize: number; // ft (visual radius)
  readonly rodeDeploySpeed: number; // ft/s
  readonly rodeRetrieveSpeed: number; // ft/s
  readonly anchorMass: number; // lbs
  readonly anchorDragCoefficient: number; // dimensionless
}

export interface JibConfig extends BaseSailConfig {}

export interface MainsheetConfig extends Partial<SheetConfig> {
  readonly boomAttachRatio: number; // 0-1 along boom
  readonly hullAttachPoint: V2d; // ft from hull center
}

export interface JibSheetConfig extends Partial<SheetConfig> {
  readonly portAttachPoint: V2d; // ft from hull center
  readonly starboardAttachPoint: V2d; // ft from hull center
}

export interface RowingConfig {
  readonly duration: number; // seconds per stroke
  readonly force: number; // lbf
}

export interface BilgeConfig {
  readonly maxWaterVolume: number; // cubic ft — cockpit capacity before swamped
  readonly pumpDrainRate: number; // cubic ft/s — automatic bilge pump rate
  readonly bailRate: number; // cubic ft/s — manual bailing removal rate
  readonly waterDensity: number; // lbs/ft³ (62.4 fresh, 64 salt)
  readonly ingressCoefficient: number; // cubic ft/s per ft of submersion depth
  readonly sloshGravity: number; // acceleration of water toward low side
  readonly sloshDamping: number; // damping on slosh velocity
  readonly halfBeam: number; // ft — half the beam at deck edge (for submersion calc)
  readonly sinkingDuration: number; // seconds — how long the sinking animation takes
}

export interface TiltConfig {
  readonly rollInertia: number; // moment of inertia for roll (lbs·ft²)
  readonly pitchInertia: number; // moment of inertia for pitch (lbs·ft²)
  readonly rollDamping: number; // angular damping coefficient for roll
  readonly pitchDamping: number; // angular damping coefficient for pitch
  readonly rightingMomentCoeff: number; // righting moment coefficient (spring stiffness)
  readonly pitchRightingCoeff: number; // pitch restoring coefficient
  readonly maxRoll: number; // max roll angle (radians)
  readonly maxPitch: number; // max pitch angle (radians)
  readonly waveRollCoeff: number; // wave slope → roll torque coefficient
  readonly wavePitchCoeff: number; // wave slope → pitch torque coefficient
  readonly zHeights: {
    readonly deck: number; // ft above waterline
    readonly boom: number; // ft above waterline
    readonly mastTop: number; // ft above waterline
    readonly keel: number; // ft below waterline (negative)
    readonly rudder: number; // average depth ft below waterline (negative)
    readonly bowsprit: number; // ft above waterline
  };
}

// ============================================
// Main BoatConfig Interface
// ============================================

export interface BoatConfig {
  readonly hull: HullConfig;
  readonly keel: KeelConfig;
  readonly rudder: RudderConfig;
  readonly rig: RigConfig;
  readonly bowsprit?: BowspritConfig;
  readonly anchor: AnchorConfig;
  readonly jib?: JibConfig;
  readonly mainsheet: MainsheetConfig;
  readonly jibSheet?: JibSheetConfig;
  readonly rowing: RowingConfig;
  readonly grounding: GroundingConfig;
  readonly tilt: TiltConfig;
  readonly bilge: BilgeConfig;
}

// Re-export boat configs
export { StarterDinghy } from "./configs/StarterDinghy";
export { StarterBoat } from "./configs/StarterBoat";

/**
 * Create a boat config with partial overrides from a base config.
 * @param base The base config to start from
 * @param overrides Partial config values to override
 * @returns Complete BoatConfig with overrides applied
 */
export function createBoatConfig(
  base: BoatConfig,
  overrides: DeepPartial<BoatConfig>,
): BoatConfig {
  return deepMerge(base, overrides);
}
