// Fluid densities in slugs/ft³ (produces lbf when used with ft and ft/s)
// Using slugs ensures F = ρ * v² * A gives force in lbf directly
// Extracted to a separate file so worker threads can import without engine deps.
export const RHO_WATER = 1.94; // Seawater at 60°F
export const RHO_AIR = 0.00238; // Air at sea level, 60°F

// Conversion factor from pounds-force (lbf) to engine force units.
//
// The physics engine uses mass in pounds (lbs) but integrates F = ma with
// g = 32.174 ft/s², which effectively treats mass as slugs (1 slug = 1 lbf·s²/ft).
// Fluid dynamics formulas using ρ in slugs/ft³ (like RHO_WATER, RHO_AIR above)
// produce force in lbf. To get the correct acceleration when applied to engine
// "mass" values, multiply lbf by g = 32.174 to convert to engine force units
// (lbm·ft/s²). Equivalently: engine_force = lbf × 32.174.
export const LBF_TO_ENGINE = 32.174;
