/**
 * Beginner's Bay - A protected bay for learning to sail.
 *
 * The bay is a horseshoe shape with:
 * - Land surrounding on west, north, and east
 * - Channel exit to the south
 * - Small practice island in the center
 */

import { V } from "../../../core/Vector";
import type { LandMass } from "../TerrainInfo";

// How far the land extends outward from the bay
const LAND_EXTENT = 600;

/**
 * The main landmass surrounding the bay.
 * This is one continuous polygon that wraps around the bay,
 * creating a horseshoe shape with the opening to the south.
 */
export const BaySurroundingLand: LandMass = {
  id: "bay-surrounding-land",
  coastline: [
    // Start at the western channel edge, go counter-clockwise around the bay

    // Western channel wall (inner edge)
    V(-80, -180),
    V(-100, -140),

    // Western shore curves north
    V(-160, -80),
    V(-200, 0),
    V(-180, 80),
    V(-140, 140),

    // Northern shore (back of bay)
    V(-80, 180),
    V(0, 200),
    V(80, 180),

    // Eastern shore curves south
    V(140, 140),
    V(180, 80),
    V(200, 0),
    V(160, -80),

    // Eastern channel wall (inner edge)
    V(100, -140),
    V(80, -180),

    // Eastern channel wall (outer edge) - goes south then wraps around
    V(80, -LAND_EXTENT),
    V(LAND_EXTENT, -LAND_EXTENT),
    V(LAND_EXTENT, LAND_EXTENT),

    // Northern outer edge
    V(-LAND_EXTENT, LAND_EXTENT),

    // Western outer edge
    V(-LAND_EXTENT, -LAND_EXTENT),
    V(-80, -LAND_EXTENT),
  ],
  peakElevation: 12,
  underwaterSlope: 0.1,
  baseDepth: -2,
};

/**
 * A small island in the bay for navigation practice.
 */
export const PracticeIsland: LandMass = {
  id: "practice-island",
  coastline: [
    V(50, -20),
    V(70, 0),
    V(65, 30),
    V(40, 45),
    V(15, 30),
    V(20, 0),
  ],
  peakElevation: 5,
  underwaterSlope: 0.25,
  baseDepth: -1,
};

/**
 * All land masses that make up the Beginner's Bay area.
 */
export const BeginnersBayLandMasses: LandMass[] = [
  BaySurroundingLand,
  PracticeIsland,
];

// Re-export individual pieces for potential customization
export const WesternShore = BaySurroundingLand;
export const NorthernShore = BaySurroundingLand;
export const EasternShore = BaySurroundingLand;
