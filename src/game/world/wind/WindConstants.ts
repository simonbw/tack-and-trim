/**
 * Shared constants for wind simulation.
 * These are used by both TypeScript code and WGSL shaders.
 */

// Wind variation configuration (matches Wind.ts)
// Units: ft for distances, radians for angles
export const WIND_NOISE_SPATIAL_SCALE = 0.005; // How quickly wind varies across space
export const WIND_NOISE_TIME_SCALE = 0.15; // How quickly wind varies over time
export const WIND_SPEED_VARIATION = 0.5; // ±50% speed variation
export const WIND_ANGLE_VARIATION = 0.17; // ±10° direction variation (~0.17 rad)
export const WIND_FLOW_CYCLE_PERIOD = 20.0; // Seconds before a flow-map layer resets
export const WIND_SLOW_TIME_SCALE = 0.02; // Very slow temporal evolution in noise z-axis

// Wind modifier limits
export const MAX_SAILS = 16;
export const MAX_TURBULENCE = 64;

// Sail wind effect constants (legacy, used by GPU shader)
export const LEEWARD_ACCELERATION = 0.15; // Flow speedup on leeward side
export const WINDWARD_BLOCKAGE = 0.1; // Flow reduction on windward side
export const WAKE_SHADOW_FACTOR = 0.2; // Wind reduction in wake
export const WAKE_LENGTH_FACTOR = 3.0; // How far wake extends (× chord length)
export const WIND_MIN_DISTANCE = 1.5; // ft - minimum distance for wind effect

// Turbulence constants (legacy, used by GPU shader)
export const TURBULENCE_STRENGTH = 3.0; // ft/s - magnitude of turbulence
export const TURBULENCE_RADIUS = 3.0; // ft - influence radius

// Wind sources
export const MAX_WIND_SOURCES = 8;

// Velocity encoding for textures
// Wind velocity range: typically -50 to +50 ft/s
export const WIND_VELOCITY_SCALE = 100.0; // Maps -50..+50 ft/s to 0..1
export const WIND_MODIFIER_SCALE = 40.0; // Maps -20..+20 ft/s delta to 0..1
