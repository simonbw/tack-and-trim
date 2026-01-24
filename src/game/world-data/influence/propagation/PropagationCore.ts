/**
 * Core utilities shared by wind and swell propagation algorithms.
 *
 * Provides common functions for direction vectors and flow weight
 * calculations used by all propagation algorithms.
 */

import { V2d } from "../../../../core/Vector";
import type { PropagationConfig } from "../PropagationConfig";

/**
 * Result from a propagation computation.
 */
export interface PropagationResult {
  /** Number of iterations performed */
  iterations: number;
  /** Maximum energy change in the final iteration */
  maxChange: number;
  /** Whether the algorithm converged before max iterations */
  converged: boolean;
}

/**
 * Get unit direction vector for a given direction index.
 *
 * Direction 0 points right (+X), and directions proceed counter-clockwise.
 *
 * @param directionIndex - Integer direction index (0 to directionCount - 1)
 * @param directionCount - Total number of directions (e.g., 16)
 */
export function getDirectionVector(
  directionIndex: number,
  directionCount: number,
): V2d {
  const angle = (directionIndex / directionCount) * Math.PI * 2;
  return V2d.fromPolar(1, angle);
}

/**
 * Compute flow weight for energy transfer from a neighbor cell to current cell.
 *
 * Energy flows preferentially in the source direction but can spread laterally.
 * No energy flows backwards (against the source direction).
 *
 * @param neighborPos - World position of the neighbor cell
 * @param currentPos - World position of the current cell
 * @param sourceDirection - Unit vector of the energy source direction
 * @param config - Propagation configuration
 * @returns Weight [0, 1] for energy transfer, 0 if energy would flow backwards
 */
export function computeFlowWeight(
  neighborPos: V2d,
  currentPos: V2d,
  sourceDirection: V2d,
  config: PropagationConfig,
): number {
  // Direction from neighbor to current (how energy would flow)
  const flowDir = currentPos.sub(neighborPos).inormalize();

  // How aligned is the flow with the source direction?
  // alignment = 1 when flowing directly with source, -1 when against
  const alignment = flowDir.dot(sourceDirection);

  // Energy doesn't flow backwards
  if (alignment <= 0) {
    return 0;
  }

  // Direct flow component (aligned with source direction)
  const directWeight = alignment * config.directFlowFactor;

  // Lateral spread component (perpendicular to source direction)
  // Higher when flow is more perpendicular (lower alignment)
  const lateralWeight = (1 - alignment) * config.lateralSpreadFactor;

  // Combined weight with decay
  return (directWeight + lateralWeight) * config.decayFactor;
}

/**
 * Get the 8 neighbor offsets for a grid cell (Moore neighborhood).
 * Returns [dx, dy] pairs for all adjacent cells.
 */
export const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Check if a grid cell is on the boundary of the grid where energy enters.
 *
 * For a given source direction, boundary cells are those on the upwind edge
 * where energy first enters the grid.
 *
 * @param x - Grid X coordinate
 * @param y - Grid Y coordinate
 * @param cellsX - Total cells in X direction
 * @param cellsY - Total cells in Y direction
 * @param sourceDirection - Unit vector of energy source direction
 * @returns True if this cell is on the upwind boundary
 */
export function isUpwindBoundary(
  x: number,
  y: number,
  cellsX: number,
  cellsY: number,
  sourceDirection: V2d,
): boolean {
  // If source comes from the right (+X), left edge is upwind
  if (sourceDirection.x > 0.1 && x === 0) return true;
  // If source comes from the left (-X), right edge is upwind
  if (sourceDirection.x < -0.1 && x === cellsX - 1) return true;
  // If source comes from above (+Y), bottom edge is upwind
  if (sourceDirection.y > 0.1 && y === 0) return true;
  // If source comes from below (-Y), top edge is upwind
  if (sourceDirection.y < -0.1 && y === cellsY - 1) return true;

  return false;
}

/**
 * Clamp a value to [0, 1] range.
 */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
