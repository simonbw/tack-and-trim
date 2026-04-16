/**
 * Station-based control system for the sailor character.
 *
 * Each station maps a subset of input axes to boat controls.
 * The player walks between stations using WASD; arriving at a
 * station snaps the sailor into position and enables that
 * station's controls.
 */

/** Boat controls that can be bound to an input axis at a station. */
export type AxisControl =
  | "rudder"
  | "mainsheet"
  | "mainHoist"
  | "jibSheets"
  | "jibHoistFurl";

/** Discrete actions available at a station via dedicated keys. */
export type ActionControl = "anchor" | "mooring";

/**
 * A named position on the boat where the sailor can stand and
 * operate a subset of controls.
 */
export interface StationDef {
  /** Unique identifier, e.g. "helm", "mast", "bow". */
  readonly id: string;
  /** Human-readable display name for HUD. */
  readonly name: string;
  /** Canonical position in hull-local XY (ft). Sailor snaps here on arrival. */
  readonly position: readonly [number, number];

  // ── Input axis bindings ─────────────────────────────────────────
  // Each axis maps one pair of keys to one boat control.
  // Omit an axis to leave it unbound at this station.

  /** What A/D (steer axis) does at this station. */
  readonly steerAxis?: AxisControl;
  /** What W/S (primary axis) does at this station. */
  readonly primaryAxis?: AxisControl;
  /** What Q/E (secondary axis) does at this station. */
  readonly secondaryAxis?: AxisControl;

  // ── Discrete actions ────────────────────────────────────────────

  /** Actions available via dedicated keys at this station. */
  readonly actions?: readonly ActionControl[];
}

/**
 * Configuration for the sailor character and its station layout
 * on a specific boat.
 */
export interface SailorConfig {
  /** Sailor mass in lbs. Affects boat balance via deck constraint reaction. */
  readonly mass: number;
  /** Maximum walking speed in ft/s along the deck. */
  readonly walkSpeed: number;
  /** Proximity radius (ft) for snapping to a station on arrival. */
  readonly snapRadius: number;
  /** Station the sailor starts at. Must match a station id. */
  readonly initialStationId: string;
  /** All stations available on this boat. */
  readonly stations: readonly StationDef[];
}
