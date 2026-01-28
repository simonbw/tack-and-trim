/**
 * Constants for sail aerodynamics and flow simulation.
 * Previously in world-data/wind/WindConstants.ts
 */

/** Radius of influence for a sail segment's pressure field (ft) */
export const SEGMENT_INFLUENCE_RADIUS = 20;

/** Turbulence decay factor per sail segment (0-1) */
export const TURBULENCE_DECAY = 0.9;

/** Turbulence level below which flow reattaches */
export const TURBULENCE_DETACH_THRESHOLD = 0.1;

/** Turbulence injected when sail would stall */
export const TURBULENCE_STALL_INJECTION = 0.5;

/** Rate at which separation effect decays with distance */
export const SEPARATION_DECAY_RATE = 0.5;
