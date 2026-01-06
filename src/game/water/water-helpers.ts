import { V2d } from "../../core/Vector";

/**
 * Function type for querying water velocity at a point.
 * Compatible with FluidVelocityFn from fluid-dynamics.ts.
 */
export type WaterVelocityFn = (point: V2d) => V2d;

/**
 * Water physics constants.
 */

/** Ratio of water density to air density (~800x denser) */
export const WATER_DENSITY_RATIO = 800;

/** Default water density in kg/m³ */
export const WATER_DENSITY = 1025;

/** Air density in kg/m³ */
export const AIR_DENSITY = 1.225;
