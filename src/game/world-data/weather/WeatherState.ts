/**
 * Weather state interface defining global atmospheric and oceanic conditions.
 *
 * This is the "input" to the wind/wave system - all terrain-aware effects
 * are derived from these global conditions combined with pre-computed influence fields.
 *
 * Units: radians for angles, ft for distances, ft/s for speeds, seconds for periods.
 */

/**
 * Wind conditions - the primary atmospheric driver.
 */
export interface WindState {
  /** Direction wind is coming FROM, in radians (0 = from east, PI/2 = from north) */
  direction: number;
  /** Base wind speed in ft/s */
  speed: number;
  /** Gust intensity multiplier (e.g., 0.1 = 10% gusts above base speed) */
  gustFactor: number;
}

/**
 * Swell conditions - long waves from distant weather systems.
 */
export interface SwellState {
  /** Direction swell is coming FROM, in radians */
  direction: number;
  /** Significant wave height in ft */
  amplitude: number;
  /** Wave period in seconds */
  period: number;
}

/**
 * Tidal state - affects water level and currents.
 */
export interface TideState {
  /** Position in tidal cycle: 0 = low tide, 0.5 = high tide, 1.0 = low tide again */
  phase: number;
  /** Tidal range in ft (difference between high and low) */
  range: number;
}

/**
 * Complete weather state for the game world.
 *
 * This changes slowly over time (minutes to hours of game time) and drives
 * all wind and wave calculations when combined with terrain influence fields.
 */
export interface WeatherState {
  /** Primary wind conditions */
  wind: WindState;

  /** Primary swell (from distant weather) */
  swell: SwellState;

  /** Optional secondary swell (from a different distant system) */
  secondarySwell?: SwellState;

  /** Tidal state */
  tide: TideState;
}

/**
 * Default wind state - moderate breeze from the east.
 */
export const DEFAULT_WIND: WindState = {
  direction: 0, // From east
  speed: 15, // ~9 knots, good sailing breeze
  gustFactor: 0.15, // 15% gusts
};

/**
 * Default swell state - gentle ocean swell.
 */
export const DEFAULT_SWELL: SwellState = {
  direction: 0.5, // From slightly north of east
  amplitude: 0.5, // ~6 inch significant height
  period: 8, // 8 second period
};

/**
 * Default tide state - mid-tide, moderate range.
 */
export const DEFAULT_TIDE: TideState = {
  phase: 0.25, // Rising tide
  range: 4, // 4 ft range
};

/**
 * Create a default weather state suitable for typical sailing conditions.
 */
export function createDefaultWeather(): WeatherState {
  return {
    wind: { ...DEFAULT_WIND },
    swell: { ...DEFAULT_SWELL },
    tide: { ...DEFAULT_TIDE },
  };
}

/**
 * Create weather state with custom parameters.
 * Unspecified parameters use defaults.
 */
export function createWeather(
  overrides: Partial<{
    wind: Partial<WindState>;
    swell: Partial<SwellState>;
    secondarySwell: SwellState;
    tide: Partial<TideState>;
  }> = {},
): WeatherState {
  return {
    wind: { ...DEFAULT_WIND, ...overrides.wind },
    swell: { ...DEFAULT_SWELL, ...overrides.swell },
    secondarySwell: overrides.secondarySwell,
    tide: { ...DEFAULT_TIDE, ...overrides.tide },
  };
}

/**
 * Get the wavelength in ft for a given wave period.
 * Uses deep water dispersion relation: λ = g * T² / (2π)
 */
export function wavelengthFromPeriod(periodSeconds: number): number {
  const g = 32.2; // ft/s² (gravity)
  return (g * periodSeconds * periodSeconds) / (2 * Math.PI);
}

/**
 * Get the wave period in seconds for a given wavelength.
 * Inverse of wavelengthFromPeriod.
 */
export function periodFromWavelength(wavelengthFt: number): number {
  const g = 32.2; // ft/s² (gravity)
  return Math.sqrt((wavelengthFt * 2 * Math.PI) / g);
}
