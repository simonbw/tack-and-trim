import { DeepPartial, deepMerge } from "../../core/util/ObjectUtils";
import { V2d } from "../../core/Vector";
import { StarterDinghy } from "./configs/StarterDinghy";
import { SailConfig } from "./Sail";
import { SheetConfig } from "./Sheet";

// ============================================
// Component Config Interfaces
// ============================================

export interface HullConfig {
  mass: number; // lbs
  vertices: V2d[]; // ft, hull shape polygon
  liftAndDrag: number; // dimensionless coefficient
  skinFrictionCoefficient: number; // dimensionless
  colors: {
    fill: number;
    stroke: number;
  };
}

export interface KeelConfig {
  vertices: V2d[]; // ft, keel shape (usually a line)
  liftAndDrag: number; // dimensionless coefficient
  color: number;
}

export interface RudderConfig {
  position: V2d; // ft from hull center
  length: number; // ft
  liftAndDrag: number; // dimensionless coefficient
  maxSteerAngle: number; // radians
  steerAdjustSpeed: number; // rad/sec
  steerAdjustSpeedFast: number; // rad/sec
  color: number;
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
  mastPosition: V2d; // ft from hull center
  boomLength: number; // ft
  boomWidth: number; // ft
  boomMass: number; // lbs
  colors: {
    mast: number;
    boom: number;
  };
  mainsail: MainsailConfig;
}

export interface BowspritConfig {
  attachPoint: V2d; // ft from hull center
  size: V2d; // ft (length, width)
  color: number;
}

export interface AnchorConfig {
  bowAttachPoint: V2d; // ft from hull center
  maxRodeLength: number; // ft
  anchorSize: number; // ft (visual radius)
  rodeDeploySpeed: number; // ft/s
  rodeRetrieveSpeed: number; // ft/s
  anchorMass: number; // lbs
  anchorDragCoefficient: number; // dimensionless
}

export interface JibConfig extends BaseSailConfig {}

export interface MainsheetConfig extends Partial<SheetConfig> {
  boomAttachRatio: number; // 0-1 along boom
  hullAttachPoint: V2d; // ft from hull center
}

export interface JibSheetConfig extends Partial<SheetConfig> {
  portAttachPoint: V2d; // ft from hull center
  starboardAttachPoint: V2d; // ft from hull center
}

export interface RowingConfig {
  duration: number; // seconds per stroke
  force: number; // lbf
}

// ============================================
// Main BoatConfig Interface
// ============================================

export interface BoatConfig {
  hull: HullConfig;
  keel: KeelConfig;
  rudder: RudderConfig;
  rig: RigConfig;
  bowsprit: BowspritConfig;
  anchor: AnchorConfig;
  jib: JibConfig;
  mainsheet: MainsheetConfig;
  jibSheet: JibSheetConfig;
  rowing: RowingConfig;
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
  overrides: DeepPartial<BoatConfig>
): BoatConfig {
  return deepMerge(base, overrides);
}
