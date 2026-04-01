import { DeepPartial, deepMerge } from "../../core/util/ObjectUtils";
import { V2d } from "../../core/Vector";
import { SailConfig } from "./sail/Sail";
import { SheetConfig } from "./Sheet";

/**
 * Boat coordinate conventions:
 *   +X = forward (toward bow)
 *   -X = aft (toward stern)
 *   +Y = starboard (right when facing forward)
 *   -Y = port (left when facing forward)
 *   +Z = up (above waterline)
 *   -Z = down (below waterline, keel/rudder depth)
 *   Z = 0 at the waterline
 *
 * Angles: radians, positive = counter-clockwise when viewed from above
 * Roll: positive = heel to port (left side down)
 * Pitch: positive = bow up
 *
 * Units: feet (length), pounds (mass), seconds (time), radians (angles)
 * Force: engine units = lbf * 32.174 (see LBF_TO_ENGINE in physics-constants.ts)
 */

// ============================================
// Component Config Interfaces
// ============================================

export interface HullConfig {
  readonly mass: number; // lbs
  readonly vertices: V2d[]; // ft, deck/gunwale polygon, counter-clockwise winding (visual/collision)
  readonly waterlineVertices?: V2d[]; // ft, narrower shape at the waterline (water interaction)
  readonly bottomVertices?: V2d[]; // ft, hull bottom shape (narrowest, at z = -draft)
  readonly skinFrictionCoefficient: number; // dimensionless Cf (typically 0.003-0.004)
  /** Pressure coefficient for front-facing (stagnation) surfaces, dimensionless.
   * Typical range 0.8-1.0. Default 1.0. */
  readonly stagnationCoefficient?: number;
  /** Pressure coefficient for rear-facing (wake/separation) surfaces, dimensionless.
   * Higher = more wake drag. Bluff stern ≈ 0.7, tapered stern ≈ 0.3. Default 0.5. */
  readonly separationCoefficient?: number;
  readonly sharpVertices?: number[]; // indices of vertices that stay sharp (not smoothed)
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
  readonly chord: number; // ft, foil chord (depth) for hydrodynamic calculations
  /** Visual color for the keel (hex RGB). */
  readonly color: number;
}

export interface RudderConfig {
  readonly position: V2d; // ft from hull center
  readonly length: number; // ft (span of rudder blade)
  readonly draft: number; // ft below waterline (tip of rudder)
  readonly chord: number; // ft, foil chord (depth) for hydrodynamic calculations
  readonly maxSteerAngle: number; // radians (typical 0.5-0.8, ~30-45°)
  readonly steerAdjustSpeed: number; // rad/s, normal steering rate (typical 0.5-1.5)
  readonly steerAdjustSpeedFast: number; // rad/s, fast steering rate (typical 1.5-3.0)
  /** Visual color for the rudder blade (hex RGB). */
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
    readonly mast: number; // hex RGB
    readonly boom: number; // hex RGB
  };
  readonly mainsail: MainsailConfig;
  readonly stays: {
    readonly forestay: V2d; // ft, hull-local attachment point for forestay
    readonly portShroud: V2d; // ft, hull-local attachment point for port shroud
    readonly starboardShroud: V2d; // ft, hull-local attachment point for starboard shroud
    readonly backstay: V2d; // ft, hull-local attachment point for backstay
    readonly deckHeight: number; // ft above waterline, z-height of deck attachment points
  };
}

export interface BowspritConfig {
  readonly attachPoint: V2d; // ft from hull center
  readonly size: V2d; // ft (length, width)
  /** Visual color for the bowsprit (hex RGB). */
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

export interface SailDamageConfig {
  readonly overpowerForceThreshold: number; // lbf — reaction force above this causes damage
  readonly overpowerDamageRate: number; // damage per lbf of excess force per second
  readonly jibeDamagePerForce: number; // damage per lbf of boom slam force (one-shot)
  readonly maxLiftReduction: number; // fraction of lift lost at health=0 (0-1)
  readonly repairRate: number; // health/s natural repair (0 = none)
}

export interface RudderDamageConfig {
  readonly groundingDamageRate: number; // damage per (ft penetration × ft/s speed × second)
  readonly groundingSpeedThreshold: number; // ft/s — below this, grounding does no damage
  readonly maxSteeringReduction: number; // fraction of steering authority lost at health=0 (0-1)
  readonly maxSteeringBias: number; // radians, max rudder bias at health=0 (pulls to one side)
  readonly repairRate: number; // health/s natural repair (0 = none)
}

export interface HullDamageConfig {
  readonly groundingDamageRate: number; // damage per (ft penetration × ft/s speed × second)
  readonly groundingSpeedThreshold: number; // ft/s — below this, grounding does no damage
  readonly damageFrictionMultiplier: number; // at health=0, Cf multiplied by (1 + this)
  readonly damageLeakRate: number; // cubic ft/s water ingress at health=0, scales with damage
  readonly repairRate: number; // health/s natural repair (0 = none)
}

export interface BilgeConfig {
  readonly maxWaterVolume: number; // cubic ft — cockpit capacity before swamped
  readonly pumpDrainRate?: number; // cubic ft/s — automatic bilge pump rate (0 or omitted = no pump)
  readonly bailBucketSize: number; // cubic ft — volume removed per bail scoop
  readonly bailInterval: number; // seconds — time between scoops
  readonly waterDensity: number; // lbs/ft³ (62.4 fresh, 64 salt)
  readonly ingressCoefficient: number; // cubic ft/s per ft of submersion depth
  readonly sloshGravity: number; // ft/s², acceleration of bilge water toward heeled side (typical 5-20)
  readonly sloshDamping: number; // dimensionless, velocity damping on bilge slosh (typical 0.5-2.0)
  readonly halfBeam: number; // ft — half the beam at deck edge (for submersion calc)
  readonly sinkingDuration: number; // seconds — how long the sinking animation takes
}

export interface TiltConfig {
  readonly rollInertia: number; // lbs·ft², moment of inertia for roll (typical 500-5000)
  readonly pitchInertia: number; // lbs·ft², moment of inertia for pitch (typical 500-5000)
  readonly rollDamping: number; // lbs·ft²/s, angular damping coefficient for roll (typical 50-500)
  readonly pitchDamping: number; // lbs·ft²/s, angular damping coefficient for pitch (typical 50-500)
  readonly rightingMomentCoeff: number; // lbs·ft/rad, righting moment spring stiffness (typical 200-2000)
  readonly pitchRightingCoeff: number; // lbs·ft/rad, pitch restoring spring stiffness (typical 200-2000)
  readonly waveRollCoeff: number; // dimensionless, wave slope to roll torque gain (typical 0.1-1.0)
  readonly wavePitchCoeff: number; // dimensionless, wave slope to pitch torque gain (typical 0.1-1.0)
  readonly zHeights: {
    readonly deck: number; // ft above waterline
    readonly boom: number; // ft above waterline
    readonly mastTop: number; // ft above waterline
    readonly keel: number; // ft below waterline (negative)
    readonly rudder: number; // average depth ft below waterline (negative)
    readonly bowsprit: number; // ft above waterline
  };
}

export interface BuoyancyConfig {
  readonly verticalMass: number; // effective mass for z-axis (lbs, ≈ displaced water mass)
  readonly rollInertia: number; // moment of inertia for roll (lbs·ft²)
  readonly pitchInertia: number; // moment of inertia for pitch (lbs·ft²)
  readonly centerOfGravityZ: number; // z of CG in body-local frame (ft, negative = below waterline)
  readonly zHeights: {
    readonly deck: number; // ft above waterline
    readonly boom: number; // ft above waterline
    readonly mastTop: number; // ft above waterline
    readonly keel: number; // ft below waterline (negative)
    readonly rudder: number; // average depth ft below waterline (negative)
    readonly bowsprit: number; // ft above waterline
  };
}

export interface LifelinesConfig {
  // Stanchion positions along deck edge (boat-local coords)
  readonly portStanchions: ReadonlyArray<readonly [number, number]>;
  readonly starboardStanchions: ReadonlyArray<readonly [number, number]>;
  // Bow pulpit path (boat-local coords, rendered as stroked open path)
  readonly bowPulpit: ReadonlyArray<readonly [number, number]>;
  // Stern pulpit path (boat-local coords)
  readonly sternPulpit: ReadonlyArray<readonly [number, number]>;
  // Height of stanchions above deck (ft)
  readonly stanchionHeight: number;
  // Visual properties
  readonly tubeColor: number; // hex RGB, stanchion and pulpit tubing color
  readonly wireColor: number; // hex RGB, lifeline wire color
  readonly tubeWidth: number; // ft, stroke width for pulpit tubing (typical 0.05-0.15)
  readonly wireWidth: number; // ft, stroke width for lifeline wires (typical 0.02-0.06)
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
  readonly lifelines?: LifelinesConfig;
  readonly anchor: AnchorConfig;
  readonly jib?: JibConfig;
  readonly mainsheet: MainsheetConfig;
  readonly jibSheet?: JibSheetConfig;
  readonly rowing: RowingConfig;
  readonly grounding: GroundingConfig;
  readonly tilt: TiltConfig;
  readonly buoyancy: BuoyancyConfig;
  readonly bilge: BilgeConfig;
  readonly hullDamage: HullDamageConfig;
  readonly rudderDamage: RudderDamageConfig;
  readonly sailDamage: SailDamageConfig;
}

// Re-export boat configs
export { Kestrel } from "./configs/Kestrel";
export { Osprey } from "./configs/Osprey";
export { Albatross } from "./configs/Albatross";

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
