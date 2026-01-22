/**
 * Coarse grid data structure for influence field storage.
 *
 * Stores data as a Float32Array with 4 floats per cell (RGBA format)
 * for direct GPU texture upload. This enables both CPU sampling and
 * GPU shader sampling from the same underlying data.
 *
 * Used by InfluenceFieldManager to store pre-computed terrain influence
 * data for wind, swell, and fetch fields.
 */

import type { InfluenceGridConfig } from "./InfluenceFieldTypes";

/** Number of floats per grid cell (RGBA format for GPU compatibility) */
export const FLOATS_PER_CELL = 4;

/**
 * Generic grid for storing influence field data in GPU-ready format.
 *
 * Data layout (matches 3D texture layout - direction is Z/depth):
 * For each direction (z = 0 to directionCount-1):
 *   For each row (y = 0 to cellsY-1):
 *     For each cell (x = 0 to cellsX-1):
 *       [float0, float1, float2, float3]  // RGBA channels
 *
 * Index calculation:
 *   offset = ((dirIndex * cellsY + y) * cellsX + x) * 4
 */
export class InfluenceFieldGrid {
  /** Grid configuration */
  readonly config: InfluenceGridConfig;

  /**
   * Raw data in GPU-ready layout.
   * 4 floats per cell (RGBA), organized as 3D texture (x, y, direction).
   */
  readonly data: Float32Array;

  /**
   * Create a new influence field grid.
   *
   * @param config - Grid configuration
   */
  constructor(config: InfluenceGridConfig) {
    this.config = config;

    // Allocate data array for all directions and cells
    const totalFloats =
      config.directionCount * config.cellsY * config.cellsX * FLOATS_PER_CELL;
    this.data = new Float32Array(totalFloats);
  }

  /**
   * Get the byte offset into the data array for a given cell.
   *
   * @param gridX - Grid X coordinate
   * @param gridY - Grid Y coordinate
   * @param directionIndex - Direction index
   * @returns Offset in floats (multiply by 4 for byte offset)
   */
  private getCellOffset(
    gridX: number,
    gridY: number,
    directionIndex: number,
  ): number {
    return (
      ((directionIndex * this.config.cellsY + gridY) * this.config.cellsX +
        gridX) *
      FLOATS_PER_CELL
    );
  }

  /**
   * Convert world coordinates to grid coordinates.
   * Returns fractional coordinates for interpolation.
   */
  worldToGrid(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: (worldX - this.config.originX) / this.config.cellSize,
      y: (worldY - this.config.originY) / this.config.cellSize,
    };
  }

  /**
   * Convert grid coordinates to world coordinates.
   * Returns the center of the cell.
   */
  gridToWorld(gridX: number, gridY: number): { x: number; y: number } {
    return {
      x: this.config.originX + (gridX + 0.5) * this.config.cellSize,
      y: this.config.originY + (gridY + 0.5) * this.config.cellSize,
    };
  }

  /**
   * Get the direction index for a given angle.
   * Returns fractional index for interpolation between directions.
   *
   * @param direction - Angle in radians
   */
  directionToIndex(direction: number): number {
    // Normalize to [0, 2π)
    const twoPi = Math.PI * 2;
    const normalized = ((direction % twoPi) + twoPi) % twoPi;
    return (normalized / twoPi) * this.config.directionCount;
  }

  /**
   * Get the direction angle for a given index.
   *
   * @param index - Direction index (0 to directionCount - 1)
   */
  indexToDirection(index: number): number {
    return (index / this.config.directionCount) * Math.PI * 2;
  }

  /**
   * Get raw cell values at integer grid coordinates.
   * Returns all 4 RGBA channels.
   *
   * @param gridX - Integer grid X coordinate
   * @param gridY - Integer grid Y coordinate
   * @param directionIndex - Integer direction index
   * @returns Array of 4 floats [R, G, B, A]
   */
  getCellDirect(
    gridX: number,
    gridY: number,
    directionIndex: number,
  ): [number, number, number, number] {
    // Clamp to grid bounds
    const x = Math.max(0, Math.min(this.config.cellsX - 1, gridX));
    const y = Math.max(0, Math.min(this.config.cellsY - 1, gridY));
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;

    const offset = this.getCellOffset(x, y, dir);
    return [
      this.data[offset],
      this.data[offset + 1],
      this.data[offset + 2],
      this.data[offset + 3],
    ];
  }

  /**
   * Set cell values at integer grid coordinates.
   *
   * @param gridX - Integer grid X coordinate
   * @param gridY - Integer grid Y coordinate
   * @param directionIndex - Integer direction index
   * @param values - Array of 4 floats [R, G, B, A]
   */
  setCellDirect(
    gridX: number,
    gridY: number,
    directionIndex: number,
    values: [number, number, number, number],
  ): void {
    if (gridX < 0 || gridX >= this.config.cellsX) return;
    if (gridY < 0 || gridY >= this.config.cellsY) return;
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;

    const offset = this.getCellOffset(gridX, gridY, dir);
    this.data[offset] = values[0];
    this.data[offset + 1] = values[1];
    this.data[offset + 2] = values[2];
    this.data[offset + 3] = values[3];
  }

  /**
   * Sample the grid at world coordinates using trilinear interpolation.
   * Interpolates in X, Y, and direction.
   *
   * @param worldX - World X coordinate
   * @param worldY - World Y coordinate
   * @param direction - Direction angle in radians
   * @returns Interpolated RGBA values
   */
  sample(
    worldX: number,
    worldY: number,
    direction: number,
  ): [number, number, number, number] {
    const grid = this.worldToGrid(worldX, worldY);
    const dirIdx = this.directionToIndex(direction);

    // Get integer and fractional parts for spatial interpolation
    const x0 = Math.floor(grid.x);
    const y0 = Math.floor(grid.y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = grid.x - x0;
    const fy = grid.y - y0;

    // Get integer and fractional parts for direction interpolation
    const d0 = Math.floor(dirIdx) % this.config.directionCount;
    const d1 = (d0 + 1) % this.config.directionCount;
    const fd = dirIdx - Math.floor(dirIdx);

    // Sample 8 corners (2 directions × 4 spatial positions)
    const v00_d0 = this.getCellDirect(x0, y0, d0);
    const v10_d0 = this.getCellDirect(x1, y0, d0);
    const v01_d0 = this.getCellDirect(x0, y1, d0);
    const v11_d0 = this.getCellDirect(x1, y1, d0);

    const v00_d1 = this.getCellDirect(x0, y0, d1);
    const v10_d1 = this.getCellDirect(x1, y0, d1);
    const v01_d1 = this.getCellDirect(x0, y1, d1);
    const v11_d1 = this.getCellDirect(x1, y1, d1);

    // Trilinear interpolation for each channel
    const result: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      // Bilinear in XY for direction 0
      const v0_d0 = v00_d0[c] + (v10_d0[c] - v00_d0[c]) * fx;
      const v1_d0 = v01_d0[c] + (v11_d0[c] - v01_d0[c]) * fx;
      const vd0 = v0_d0 + (v1_d0 - v0_d0) * fy;

      // Bilinear in XY for direction 1
      const v0_d1 = v00_d1[c] + (v10_d1[c] - v00_d1[c]) * fx;
      const v1_d1 = v01_d1[c] + (v11_d1[c] - v01_d1[c]) * fx;
      const vd1 = v0_d1 + (v1_d1 - v0_d1) * fy;

      // Interpolate between directions
      result[c] = vd0 + (vd1 - vd0) * fd;
    }

    return result;
  }

  /**
   * Sample the grid at world coordinates for a single direction.
   * Uses bilinear interpolation in X and Y only.
   *
   * @param worldX - World X coordinate
   * @param worldY - World Y coordinate
   * @param directionIndex - Integer direction index
   * @returns Interpolated RGBA values
   */
  sampleAtDirection(
    worldX: number,
    worldY: number,
    directionIndex: number,
  ): [number, number, number, number] {
    const grid = this.worldToGrid(worldX, worldY);

    const x0 = Math.floor(grid.x);
    const y0 = Math.floor(grid.y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = grid.x - x0;
    const fy = grid.y - y0;

    const v00 = this.getCellDirect(x0, y0, directionIndex);
    const v10 = this.getCellDirect(x1, y0, directionIndex);
    const v01 = this.getCellDirect(x0, y1, directionIndex);
    const v11 = this.getCellDirect(x1, y1, directionIndex);

    const result: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const v0 = v00[c] + (v10[c] - v00[c]) * fx;
      const v1 = v01[c] + (v11[c] - v01[c]) * fx;
      result[c] = v0 + (v1 - v0) * fy;
    }

    return result;
  }

  /**
   * Check if world coordinates are within the grid bounds.
   */
  isInBounds(worldX: number, worldY: number): boolean {
    const grid = this.worldToGrid(worldX, worldY);
    return (
      grid.x >= 0 &&
      grid.x < this.config.cellsX &&
      grid.y >= 0 &&
      grid.y < this.config.cellsY
    );
  }

  /**
   * Get the world-space bounds of the grid.
   */
  getWorldBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    return {
      minX: this.config.originX,
      maxX: this.config.originX + this.config.cellsX * this.config.cellSize,
      minY: this.config.originY,
      maxY: this.config.originY + this.config.cellsY * this.config.cellSize,
    };
  }

  /**
   * Iterate over all cells in the grid for a specific direction.
   *
   * @param directionIndex - Integer direction index
   * @param callback - Function to call for each cell
   */
  forEachCell(
    directionIndex: number,
    callback: (
      gridX: number,
      gridY: number,
      values: [number, number, number, number],
    ) => void,
  ): void {
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;

    for (let y = 0; y < this.config.cellsY; y++) {
      for (let x = 0; x < this.config.cellsX; x++) {
        const offset = this.getCellOffset(x, y, dir);
        callback(x, y, [
          this.data[offset],
          this.data[offset + 1],
          this.data[offset + 2],
          this.data[offset + 3],
        ]);
      }
    }
  }
}

/**
 * Create a grid configuration for a given world area.
 *
 * @param minX - Minimum world X coordinate
 * @param maxX - Maximum world X coordinate
 * @param minY - Minimum world Y coordinate
 * @param maxY - Maximum world Y coordinate
 * @param cellSize - Size of each grid cell in ft
 * @param directionCount - Number of pre-computed directions
 */
export function createGridConfig(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  cellSize: number,
  directionCount: number,
): InfluenceGridConfig {
  const width = maxX - minX;
  const height = maxY - minY;

  return {
    cellSize,
    cellsX: Math.ceil(width / cellSize),
    cellsY: Math.ceil(height / cellSize),
    originX: minX,
    originY: minY,
    directionCount,
  };
}
