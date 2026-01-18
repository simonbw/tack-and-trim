/**
 * Beginner's Bay - A protected bay for learning to sail.
 *
 * Features:
 * - Semi-enclosed bay with shallow, calm water
 * - Narrow channel exit to open ocean
 * - Gradual depth increase toward channel
 * - Sandy beaches surrounding the bay
 */

import { V } from "../../../core/Vector";
import type { LandMass } from "../TerrainInfo";

/**
 * The main shoreline surrounding Beginner's Bay.
 * Creates a horseshoe-shaped bay with a narrow opening to the south.
 */
export const BeginnersBayShoreline: LandMass = {
  id: "beginners-bay-shore",
  coastline: [
    // Starting from southwest, going counter-clockwise
    // Western shore
    V(-180, -120),
    V(-220, -60),
    V(-240, 0),
    V(-220, 80),
    V(-180, 140),

    // Northern shore (back of bay)
    V(-100, 180),
    V(0, 200),
    V(100, 180),

    // Eastern shore
    V(180, 140),
    V(220, 80),
    V(240, 0),
    V(220, -60),
    V(180, -120),

    // Channel opening (narrow gap in the south)
    // Eastern side of channel
    V(120, -160),
    V(80, -220),
    V(60, -300),

    // Channel continues south (deep water exit)
    V(60, -400),
    V(-60, -400),

    // Western side of channel
    V(-60, -300),
    V(-80, -220),
    V(-120, -160),
  ],
  peakElevation: 10, // 10 feet above water at highest point
  underwaterSlope: 0.08, // Gentle slope - drops 1 foot per ~12 feet
  baseDepth: -2, // 2 feet deep right at shoreline (wading depth)
};

/**
 * A small island in the middle of the bay for navigation practice.
 */
export const PracticeIsland: LandMass = {
  id: "practice-island",
  coastline: [
    V(60, 60),
    V(80, 80),
    V(70, 110),
    V(40, 120),
    V(20, 100),
    V(30, 70),
  ],
  peakElevation: 6,
  underwaterSlope: 0.15,
  baseDepth: -1,
};

/**
 * All land masses that make up the Beginner's Bay area.
 */
export const BeginnersBayLandMasses: LandMass[] = [
  BeginnersBayShoreline,
  PracticeIsland,
];
