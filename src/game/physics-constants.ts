// Fluid densities in slugs/ft³ (produces lbf when used with ft and ft/s)
// Using slugs ensures F = ρ * v² * A gives force in lbf directly
// Extracted to a separate file so worker threads can import without engine deps.
export const RHO_WATER = 1.94; // Seawater at 60°F
export const RHO_AIR = 0.00238; // Air at sea level, 60°F
