import { DeepPartial, deepMerge } from "../../core/util/ObjectUtils";
import { V2d } from "../../core/Vector";
import { SailConfig } from "./sail/Sail";
import { StationDef } from "./sailor/StationConfig";
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

// ============================================
// Hull Shape Definition (Station Profiles)
// ============================================

/**
 * A cross-section profile at a specific x-station along the hull.
 * Each profile is a half-curve in the y-z plane (starboard side only),
 * automatically mirrored for the port side.
 *
 * Control points go from keel center (y≈0, z=bottom) up to gunwale (y=beam, z=top).
 * Intermediate points define the hull's cross-sectional curvature — round bilge,
 * hard chine, tumblehome, flare, etc.
 */
export interface HullStation {
  /** Position along the hull length (ft). +X = forward. */
  readonly x: number;
  /**
   * Half-profile control points as [y, z] pairs (ft).
   * - y = distance from centerline (0 = keel center, positive = starboard)
   * - z = height (0 = waterline, positive = above, negative = below)
   * - First point should be near y=0 (keel/centerline)
   * - Last point is the gunwale
   *
   * Points are spline-interpolated to create a smooth curve.
   * At the bow, the profile may collapse to a single point [0, z].
   */
  readonly profile: ReadonlyArray<readonly [number, number]>;
}

/**
 * Hull shape defined as a series of cross-section profiles at stations
 * along the hull length, like a naval architecture "lines drawing."
 *
 * The system interpolates between stations and lofts the resulting profiles
 * into a 3D triangle mesh. Port side is auto-mirrored from starboard.
 */
export interface HullShape {
  /** Cross-section stations ordered from stern to bow. */
  readonly stations: readonly HullStation[];
  /**
   * Indices of stations to keep sharp (no smoothing in the x-direction).
   * Typically the bow station.
   */
  readonly sharpStations?: readonly number[];
  /**
   * Number of interpolated points per profile curve segment.
   * Higher = smoother cross-sections. Default 4.
   */
  readonly profileSubdivisions?: number;
  /**
   * Number of interpolated stations between each defined station.
   * Higher = smoother hull surface along the length. Default 4.
   */
  readonly stationSubdivisions?: number;
}

// ============================================
// Deck Plan (Interior Features)
// ============================================

/**
 * Zone type hint for gameplay logic, editor tooling, and validation.
 * All zones render the same way (polygon floor + optional walls);
 * the type is semantic metadata.
 */
export type DeckZoneType =
  | "deck" // main deck surface
  | "cockpit" // recessed crew area
  | "cabin" // raised cabin trunk
  | "sole" // interior floor (cabin sole, cockpit sole)
  | "bench" // seating surface
  | "seat" // individual seat
  | "companionway" // opening/passage between areas
  | "locker" // storage area
  | "lazarette"; // stern storage

/**
 * A named zone in the deck plan with a polygon outline, floor height,
 * optional walls, and visual properties.
 */
export interface DeckZone {
  readonly name: string;
  readonly type: DeckZoneType;
  /**
   * Polygon outline in hull-local XY coordinates (ft).
   * Does not need to match the hull outline exactly — zones are
   * automatically clipped to the hull's deck edge during rendering.
   */
  readonly outline: ReadonlyArray<readonly [number, number]>;
  /** Floor/surface height (ft above waterline). */
  readonly floorZ: number;
  /**
   * Wall height above floorZ (ft). If set, vertical walls are rendered
   * around the zone boundary up to floorZ + wallHeight.
   * For cockpits, this is the coaming height.
   * For cabins, this is the cabin trunk height.
   */
  readonly wallHeight?: number;
  /** Floor/surface color (hex RGB). */
  readonly color: number;
  /** Wall color (hex RGB). Defaults to a darker shade of floor color. */
  readonly wallColor?: number;
}

/**
 * Deck plan defining interior features of the boat.
 * Zones are rendered bottom-up by floorZ, with higher zones drawing
 * over lower ones. Zone polygons are clipped to the hull deck outline.
 */
export interface DeckPlan {
  readonly zones: readonly DeckZone[];
}

// ============================================
// Hull Config
// ============================================

export interface HullConfig {
  readonly mass: number; // lbs
  // --- 2D deck polygon (used for collision shape, wake, etc.) ---
  readonly vertices: V2d[]; // ft, deck/gunwale polygon, counter-clockwise winding (visual/collision)
  // --- Station profile hull shape (lofted into the 3D physics + render mesh) ---
  readonly shape: HullShape;
  // --- Deck plan (interior features) ---
  readonly deckPlan?: DeckPlan;
  // --- Common properties ---
  readonly skinFrictionCoefficient: number; // dimensionless Cf (typically 0.003-0.004)
  /** Pressure coefficient for front-facing (stagnation) surfaces, dimensionless.
   * Typical range 0.8-1.0. Default 1.0. */
  readonly stagnationCoefficient?: number;
  /** Pressure coefficient for rear-facing (wake/separation) surfaces, dimensionless.
   * Higher = more wake drag. Bluff stern ≈ 0.7, tapered stern ≈ 0.3. Default 0.5. */
  readonly separationCoefficient?: number;
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
  /** Visual color for the tiller arm above deck (hex RGB). */
  readonly tillerColor: number;
}

/**
 * How the helm is controlled visually. Physics and input are identical
 * either way — this only affects the rendered helm and (for wheels) lets
 * the visual live somewhere other than the rudder stock.
 */
export interface HelmConfig {
  readonly type: "tiller" | "wheel";
  /**
   * Hull-local XY position of the helm visual.
   * For tillers: defaults to the rudder pivot (stock-mounted tiller).
   * For wheels: required — the wheel pedestal location in the cockpit.
   */
  readonly position?: V2d;
  /** Wheel rim radius in ft. Only used when type is "wheel". */
  readonly radius?: number;
  /**
   * Visual turns lock-to-lock for the wheel. Larger values make the wheel
   * visually spin faster than the rudder moves. Default 1.
   */
  readonly turns?: number;
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
    /**
     * Backstay bridle: runs from the masthead down to the `split` point,
     * then Y-splits to deck attachments at the two transom corners. Keeps
     * the backstay clear of the helmsman at the tiller.
     */
    readonly backstay: {
      readonly split: V2d; // ft, hull-local xy of the Y-join above deck
      readonly splitZ: number; // ft above waterline, z of the Y-join
      readonly port: V2d; // ft, hull-local port transom attachment
      readonly starboard: V2d; // ft, hull-local starboard transom attachment
    };
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
  readonly anchorMass: number; // lbs
  readonly deckHeight: number; // ft above waterline — z for bow roller, winch, and stowed anchor
  readonly rollInertia: number; // lb·ft² — moment of inertia for roll
  readonly pitchInertia: number; // lb·ft² — moment of inertia for pitch (around lateral axis)
  readonly yawInertia: number; // lb·ft² — moment of inertia for yaw
  /** Body-local offset [x,y,z] where the rode attaches — toward top of shank so tension creates pitch torque. */
  readonly rodeAttachOffset: readonly [number, number, number];
  readonly anchorDragCoefficient: number; // scope-based holding drag when set on bottom
  readonly hoistForce?: number; // lbf for winch when raising (default 15)
  /** Visual rope pattern for the rode. Defaults to a solid dark color. */
  readonly ropePattern?: import("./RopeShader").RopePattern;
}

export interface JibConfig extends BaseSailConfig {}

export interface MainsheetConfig extends Partial<SheetConfig> {
  readonly boomAttachRatio: number; // 0-1 along boom
  readonly hullAttachPoint: V2d; // ft from hull center (cleat — tail end of sheet)
  /** Winch position on deck (hull-local). Rope controlled here by crew. */
  readonly winchPoint?: V2d;
}

export interface HalyardConfig {
  /** Hull-local cleat position where the halyard tail terminates (ft). */
  readonly cleatPoint: V2d;
  /** Z-height of the cleat above the waterline (ft). */
  readonly cleatZ: number;
  /**
   * Hull-local xy offset from the mast centerline for the sheave (block) at
   * the mast top. The halyard wraps over this block as it transitions from
   * ascending (tail) to descending (sail head) side. A small forward offset
   * visually separates the sheave from the mast cylinder. Default `(0, 0)`.
   */
  readonly sheaveOffset?: V2d;
  /**
   * Sheave height above the mast top (ft). Sheaves typically sit just above
   * the sail head so the head can be hoisted to its maximum height without
   * jamming. Default 0.3.
   */
  readonly sheaveElevation?: number;
  /**
   * Hull-local xy offset from the mast centerline where the halyard
   * terminates at the sail head. Usually a small aft offset so the rope
   * runs down the sail's luff side of the mast. Default `(0, 0)`.
   */
  readonly headOffset?: V2d;
  /** Sheave drum radius for the wrap geometry at the mast top (ft). Default 0.12. */
  readonly sheaveRadius?: number;
  /** Rope thickness (world ft). Default 0.15 — matches sheet ropes. */
  readonly ropeThickness?: number;
  /** Fallback solid color if no ropePattern is specified. */
  readonly ropeColor?: number;
  /** Carrier pattern — usually supplied by the brand palette. */
  readonly ropePattern?: import("./RopeShader").RopePattern;
}

export interface JibSheetConfig extends Partial<SheetConfig> {
  readonly portAttachPoint: V2d; // ft from hull center (cleat — tail end)
  readonly starboardAttachPoint: V2d; // ft from hull center (cleat — tail end)
  /** Optional block position for port sheet (hull-local). Rope routes through this. */
  readonly portBlockPoint?: V2d;
  /** Optional block position for starboard sheet (hull-local). */
  readonly starboardBlockPoint?: V2d;
  /** Winch position for port sheet (hull-local). */
  readonly portWinchPoint?: V2d;
  /** Winch position for starboard sheet (hull-local). */
  readonly starboardWinchPoint?: V2d;
  /** Coulomb friction coefficient for jib sheet blocks. 0 = frictionless. Default 0. */
  readonly blockFrictionCoefficient?: number;
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
  readonly maxWaterVolume?: number; // cubic ft — override; if omitted, computed from hull geometry
  readonly pumpDrainRate?: number; // cubic ft/s — automatic bilge pump rate (0 or omitted = no pump)
  readonly bailBucketSize: number; // cubic ft — volume removed per bail scoop
  readonly bailInterval: number; // seconds — time between scoops
  readonly waterDensity: number; // lbs/ft³ (62.4 fresh, 64 salt)
  /** Natural frequency (rad/s) of the lateral slosh oscillator. ~3-5 for a keelboat. */
  readonly sloshFreqLateral: number;
  /** Natural frequency (rad/s) of the longitudinal slosh oscillator. Usually lower than lateral. */
  readonly sloshFreqLongitudinal: number;
  /** Damping ratio (0 = undamped, 1 = critical); ~0.3-0.5 looks alive. */
  readonly sloshDampingRatio: number;
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
  /** Optional helm visual. If omitted, renders a tiller at the rudder stock. */
  readonly helm?: HelmConfig;
  readonly rig: RigConfig;
  readonly bowsprit?: BowspritConfig;
  readonly lifelines?: LifelinesConfig;
  readonly anchor: AnchorConfig;
  readonly jib?: JibConfig;
  readonly mainsheet: MainsheetConfig;
  readonly jibSheet?: JibSheetConfig;
  readonly halyard: HalyardConfig;
  readonly rowing: RowingConfig;
  readonly grounding: GroundingConfig;
  readonly tilt: TiltConfig;
  readonly buoyancy: BuoyancyConfig;
  readonly bilge: BilgeConfig;
  readonly hullDamage: HullDamageConfig;
  readonly rudderDamage: RudderDamageConfig;
  readonly sailDamage: SailDamageConfig;
  /** Sailor stations on this boat. Every boat must have at least one. */
  readonly stations: readonly StationDef[];
  /** Station id where the sailor starts. Must match a station in `stations`. */
  readonly initialStationId: string;
  /**
   * Marine compass dial colors shown in the navigation HUD. Set by the brand
   * palette via `withBrandPalette`; `BaseBoat` ships a neutral default so
   * unbranded configs (tests, the boat editor preview) still type-check.
   */
  readonly compass: CompassPalette;
}

/**
 * Color palette for the rotating compass card in the navigation HUD. Brands
 * choose hues; the HUD applies opacity/contrast in CSS so the dial stays
 * legible against the world without each palette having to think about it.
 */
export interface CompassPalette {
  /** Outer bezel ring (the "watch frame"). */
  readonly bezel: number;
  /** Dial face background — rendered semi-transparent over the world. */
  readonly face: number;
  /** Major tick marks + cardinal letters (E/S/W) — the high-contrast ink. */
  readonly ink: number;
  /** Minor tick marks + intercardinal letters (NE/SE/SW/NW) — softer ink. */
  readonly inkSoft: number;
  /** N letter — the brand's accent for due north. */
  readonly north: number;
  /**
   * Compass-rose ray pointing to north — typically a distinctive accent.
   * Omit (along with `rayCardinal`) to render the dial without a rose.
   */
  readonly rayNorth?: number;
  /** Compass-rose rays pointing to E/S/W. Omit to render the dial without a rose. */
  readonly rayCardinal?: number;
  /** Lubber pointer wedge + center pivot dot. */
  readonly lubber: number;
  /** Heading readout text rendered below the dial. */
  readonly label: number;
  /**
   * CSS font-family stack for compass labels and the heading readout. Brands
   * that want a custom typographic identity set this; undefined uses the
   * shared serif default.
   */
  readonly font?: string;
  /**
   * CSS font-weight for compass labels. Brands using a display serif may want
   * a lighter cut (e.g. 400) for elegance; default is 700 for legibility on
   * sturdier faces.
   */
  readonly fontWeight?: number | string;
}

// Re-export boat configs — Shaff
export { ShaffS7 } from "./configs/ShaffS7";
export { ShaffS11 } from "./configs/ShaffS11";
export { ShaffS15 } from "./configs/ShaffS15";
export { ShaffS20 } from "./configs/ShaffS20";
// Re-export boat configs — BHC
export { BhcDaysailer } from "./configs/BhcDaysailer";
export { BhcWeekender } from "./configs/BhcWeekender";
export { BhcJourney } from "./configs/BhcJourney";
export { BhcExpedition } from "./configs/BhcExpedition";
// Re-export boat configs — Maestro
export { MaestroEtude } from "./configs/MaestroEtude";
export { MaestroTrio } from "./configs/MaestroTrio";
export { MaestroFantasia } from "./configs/MaestroFantasia";
export { MaestroOpus } from "./configs/MaestroOpus";

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
