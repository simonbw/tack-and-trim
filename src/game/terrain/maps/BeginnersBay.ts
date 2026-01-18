/**
 * Beginner's Bay - A protected bay for learning to sail.
 *
 * The bay is rendered as three separate land masses (shores) that
 * surround the water. Each shore is a simple convex-ish polygon
 * that the renderer can handle correctly.
 */

import { V } from "../../../core/Vector";
import type { LandMass } from "../TerrainInfo";

// How far the land extends outward from the bay
const LAND_EXTENT = 600;

/**
 * Western shore - extends from southwest to northwest
 */
export const WesternShore: LandMass = {
  id: "western-shore",
  coastline: [
    // Inner edge (bay side), from south to north
    V(-80, -200),
    V(-120, -140),
    V(-180, -60),
    V(-200, 20),
    V(-180, 100),
    V(-120, 160),
    V(-60, 200),
    // Outer edge (west side)
    V(-LAND_EXTENT, 200),
    V(-LAND_EXTENT, -200),
  ],
  peakElevation: 10,
  underwaterSlope: 0.1,
  baseDepth: -2,
};

/**
 * Northern shore - spans the back of the bay
 */
export const NorthernShore: LandMass = {
  id: "northern-shore",
  coastline: [
    // Inner edge (bay side), from west to east
    V(-60, 200),
    V(0, 220),
    V(60, 200),
    // Outer edge (north side)
    V(60, LAND_EXTENT),
    V(-60, LAND_EXTENT),
  ],
  peakElevation: 12,
  underwaterSlope: 0.1,
  baseDepth: -2,
};

/**
 * Eastern shore - extends from northeast to southeast
 */
export const EasternShore: LandMass = {
  id: "eastern-shore",
  coastline: [
    // Inner edge (bay side), from north to south
    V(60, 200),
    V(120, 160),
    V(180, 100),
    V(200, 20),
    V(180, -60),
    V(120, -140),
    V(80, -200),
    // Outer edge (east side)
    V(LAND_EXTENT, -200),
    V(LAND_EXTENT, 200),
  ],
  peakElevation: 10,
  underwaterSlope: 0.1,
  baseDepth: -2,
};

/**
 * A small island in the bay for navigation practice.
 */
export const PracticeIsland: LandMass = {
  id: "practice-island",
  coastline: [
    V(40, 20),
    V(60, 40),
    V(55, 70),
    V(30, 80),
    V(10, 60),
    V(20, 30),
  ],
  peakElevation: 5,
  underwaterSlope: 0.25,
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
