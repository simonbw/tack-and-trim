/**
 * Shared constants for wind simulation.
 * These are used by both TypeScript code and WGSL shaders.
 */

// Texture resolution for wind data (per tile)
// Higher than water (256 vs 128) because wind affects individual sail segments
export const WIND_TEXTURE_SIZE = 256;

// Wind variation configuration (matches Wind.ts)
// Units: ft for distances, radians for angles
export const WIND_NOISE_SPATIAL_SCALE = 0.005; // How quickly wind varies across space
export const WIND_NOISE_TIME_SCALE = 0.15; // How quickly wind varies over time
export const WIND_SPEED_VARIATION = 0.5; // ±50% speed variation
export const WIND_ANGLE_VARIATION = 0.17; // ±10° direction variation (~0.17 rad)

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

// Flow propagation constants (for intra-sail simulation)
export const TURBULENCE_DECAY = 0.9; // Per-segment turbulence decay
export const TURBULENCE_STALL_INJECTION = 0.3; // Turbulence added when segment stalls
export const TURBULENCE_DETACH_THRESHOLD = 0.5; // Turbulence level that causes flow detachment
export const SEPARATION_DECAY_RATE = 0.1; // How quickly separated flow recovers
export const SEGMENT_INFLUENCE_RADIUS = 8; // ft - how far segment pressure extends

// Velocity encoding for textures
// Wind velocity range: typically -50 to +50 ft/s
export const WIND_VELOCITY_SCALE = 100.0; // Maps -50..+50 ft/s to 0..1
export const WIND_MODIFIER_SCALE = 40.0; // Maps -20..+20 ft/s delta to 0..1

/**
 * WGSL code snippet defining wind constants.
 * Interpolate this into shaders that need wind parameters.
 */
export const WIND_CONSTANTS_WGSL = /*wgsl*/ `
const PI: f32 = 3.14159265359;

// Wind variation
const WIND_NOISE_SPATIAL_SCALE: f32 = ${WIND_NOISE_SPATIAL_SCALE};
const WIND_NOISE_TIME_SCALE: f32 = ${WIND_NOISE_TIME_SCALE};
const WIND_SPEED_VARIATION: f32 = ${WIND_SPEED_VARIATION};
const WIND_ANGLE_VARIATION: f32 = ${WIND_ANGLE_VARIATION};

// Wind modifier limits
const MAX_SAILS: u32 = ${MAX_SAILS}u;
const MAX_TURBULENCE: u32 = ${MAX_TURBULENCE}u;

// Sail wind effect constants
const LEEWARD_ACCELERATION: f32 = ${LEEWARD_ACCELERATION};
const WINDWARD_BLOCKAGE: f32 = ${WINDWARD_BLOCKAGE};
const WAKE_SHADOW_FACTOR: f32 = ${WAKE_SHADOW_FACTOR};
const WAKE_LENGTH_FACTOR: f32 = ${WAKE_LENGTH_FACTOR};
const WIND_MIN_DISTANCE: f32 = ${WIND_MIN_DISTANCE};

// Turbulence constants
const TURBULENCE_STRENGTH: f32 = ${TURBULENCE_STRENGTH};
const TURBULENCE_RADIUS: f32 = ${TURBULENCE_RADIUS};

// Velocity encoding
const WIND_VELOCITY_SCALE: f32 = ${WIND_VELOCITY_SCALE};
const WIND_MODIFIER_SCALE: f32 = ${WIND_MODIFIER_SCALE};
`;
