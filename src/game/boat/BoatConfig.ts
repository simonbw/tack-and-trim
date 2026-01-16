import { DeepPartial, deepMerge } from "../../core/util/ObjectUtils";
import { V2d } from "../../core/Vector";
import { StarterDinghy } from "./configs/StarterDinghy";
import { SailConfig } from "./sail";
import { SheetConfig } from "./Sheet";

// ============================================
// Component Config Interfaces
// ============================================

export interface HullConfig {
  readonly mass: number; // lbs
  readonly vertices: V2d[]; // ft, hull shape polygon, counter-clockwise winding
  readonly skinFrictionCoefficient: number; // dimensionless Cf (typically 0.003-0.004)
  readonly colors: {
    readonly fill: number;
    readonly stroke: number;
  };
}

export interface KeelConfig {
  readonly vertices: V2d[]; // ft, keel shape (usually a line)
  readonly color: number;
}

export interface RudderConfig {
  readonly position: V2d; // ft from hull center
  readonly length: number; // ft (span of rudder blade)
  readonly maxSteerAngle: number; // radians
  readonly steerAdjustSpeed: number; // rad/sec
  readonly steerAdjustSpeedFast: number; // rad/sec
  readonly color: number;
}

// Sail physics properties configurable per-boat (optional, defaults in Sail.ts)
export type BaseSailConfig = Partial<
  Pick<
    SailConfig,
    | "nodeCount"
    | "nodeMass"
    | "slackFactor"
    | "liftScale"
    | "dragScale"
    | "billowOuter"
    | "windInfluenceRadius"
    | "hoistSpeed"
    | "color"
  >
>;

export interface MainsailConfig extends BaseSailConfig {
  billowInner?: number;
}

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

// ============================================
// Main BoatConfig Interface
// ============================================

export interface BoatConfig {
  readonly hull: HullConfig;
  readonly keel: KeelConfig;
  readonly rudder: RudderConfig;
  readonly rig: RigConfig;
  readonly bowsprit: BowspritConfig;
  readonly anchor: AnchorConfig;
  readonly jib: JibConfig;
  readonly mainsheet: MainsheetConfig;
  readonly jibSheet: JibSheetConfig;
  readonly rowing: RowingConfig;
}

// Re-export boat configs
export { StarterDinghy } from "./configs/StarterDinghy";

/** @deprecated Use StarterDinghy instead */
export const DEFAULT_BOAT_CONFIG = StarterDinghy;

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
