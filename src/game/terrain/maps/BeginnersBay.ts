/**
 * Beginner's Bay - A protected bay for learning to sail.
 *
 * The bay is defined by the LAND that surrounds it, not the water area.
 * We render the shores/beaches as filled polygons, leaving the bay
 * center as open water.
 *
 * Layout:
 * - Western shore curves from southwest to northwest
 * - Northern shore spans the back of the bay
 * - Eastern shore curves from northeast to southeast
 * - Channel opening in the south (gap between east and west shores)
 */

import { V } from "../../../core/Vector";
import type { LandMass } from "../TerrainInfo";

// How far the land extends outward from the bay
const LAND_EXTENT = 500;

/**
 * Western shore - land mass on the west side of the bay
 */
export const WesternShore: LandMass = {
  id: "western-shore",
  coastline: [
    // Inner edge (bay side) - from channel to north
    V(-120, -160),
    V(-180, -120),
    V(-220, -60),
    V(-240, 0),
    V(-220, 80),
    V(-180, 140),
    V(-100, 180),

    // Outer edge (extends into "infinity")
    V(-100, LAND_EXTENT),
    V(-LAND_EXTENT, LAND_EXTENT),
    V(-LAND_EXTENT, -LAND_EXTENT),
    V(-80, -LAND_EXTENT),
    V(-80, -220),
  ],
  peakElevation: 10,
  underwaterSlope: 0.08,
  baseDepth: -2,
};

/**
 * Northern shore - land mass at the back of the bay
 */
export const NorthernShore: LandMass = {
  id: "northern-shore",
  coastline: [
    // Inner edge (bay side)
    V(-100, 180),
    V(0, 200),
    V(100, 180),

    // Outer edge (extends north)
    V(100, LAND_EXTENT),
    V(-100, LAND_EXTENT),
  ],
  peakElevation: 12,
  underwaterSlope: 0.08,
  baseDepth: -2,
};

/**
 * Eastern shore - land mass on the east side of the bay
 */
export const EasternShore: LandMass = {
  id: "eastern-shore",
  coastline: [
    // Inner edge (bay side) - from north to channel
    V(100, 180),
    V(180, 140),
    V(220, 80),
    V(240, 0),
    V(220, -60),
    V(180, -120),
    V(120, -160),

    // Channel side going south
    V(80, -220),
    V(80, -LAND_EXTENT),

    // Outer edge (extends east)
    V(LAND_EXTENT, -LAND_EXTENT),
    V(LAND_EXTENT, LAND_EXTENT),
    V(100, LAND_EXTENT),
  ],
  peakElevation: 10,
  underwaterSlope: 0.08,
  baseDepth: -2,
};

/**
 * A small island in the bay for navigation practice.
 */
export const PracticeIsland: LandMass = {
  id: "practice-island",
  coastline: [
    V(60, -40),
    V(80, -20),
    V(75, 10),
    V(50, 20),
    V(30, 5),
    V(40, -30),
  ],
  peakElevation: 4,
  underwaterSlope: 0.2,
  baseDepth: -1,
};

/**
 * All land masses that make up the Beginner's Bay area.
 */
export const BeginnersBayLandMasses: LandMass[] = [
  WesternShore,
  NorthernShore,
  EasternShore,
  PracticeIsland,
];
