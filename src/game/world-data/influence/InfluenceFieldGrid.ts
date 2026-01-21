/**
 * Generic coarse grid data structure for influence field storage.
 *
 * Stores typed data at each cell with support for:
 * - Bilinear interpolation sampling
 * - World-to-grid coordinate conversion
 * - Serialization for potential caching
 *
 * Used by WindInfluenceField, SwellInfluenceField, and FetchMap to store
 * pre-computed terrain influence data.
 */

import type { InfluenceGridConfig } from "./InfluenceFieldTypes";

/**
 * Generic grid for storing influence field data.
 *
 * @typeParam T - The type of data stored at each grid cell
 */
export class InfluenceFieldGrid<T> {
  /** Grid configuration */
  readonly config: InfluenceGridConfig;

  /** Raw cell data, indexed by [y * cellsX + x] for each direction */
  private readonly data: T[][];

  /**
   * Create a new influence field grid.
   *
   * @param config - Grid configuration
   * @param createDefault - Factory function to create default cell value
   */
  constructor(config: InfluenceGridConfig, createDefault: () => T) {
    this.config = config;

    // Initialize data array for each direction
    this.data = new Array(config.directionCount);
    const cellCount = config.cellsX * config.cellsY;
    for (let dir = 0; dir < config.directionCount; dir++) {
      this.data[dir] = new Array(cellCount);
      for (let i = 0; i < cellCount; i++) {
        this.data[dir][i] = createDefault();
      }
    }
  }

  /**
   * Get the cell index for a grid coordinate.
   */
  private getCellIndex(gridX: number, gridY: number): number {
    return gridY * this.config.cellsX + gridX;
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
   * Get the raw cell value at integer grid coordinates for a specific direction.
   * Does not perform any interpolation.
   *
   * @param gridX - Integer grid X coordinate
   * @param gridY - Integer grid Y coordinate
   * @param directionIndex - Integer direction index
   */
  getCellDirect(gridX: number, gridY: number, directionIndex: number): T {
    // Clamp to grid bounds
    const x = Math.max(0, Math.min(this.config.cellsX - 1, gridX));
    const y = Math.max(0, Math.min(this.config.cellsY - 1, gridY));
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;
    return this.data[dir][this.getCellIndex(x, y)];
  }

  /**
   * Set the cell value at integer grid coordinates for a specific direction.
   *
   * @param gridX - Integer grid X coordinate
   * @param gridY - Integer grid Y coordinate
   * @param directionIndex - Integer direction index
   * @param value - Value to set
   */
  setCellDirect(
    gridX: number,
    gridY: number,
    directionIndex: number,
    value: T,
  ): void {
    if (gridX < 0 || gridX >= this.config.cellsX) return;
    if (gridY < 0 || gridY >= this.config.cellsY) return;
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;
    this.data[dir][this.getCellIndex(gridX, gridY)] = value;
  }

  /**
   * Sample the grid at world coordinates using bilinear interpolation.
   *
   * @param worldX - World X coordinate
   * @param worldY - World Y coordinate
   * @param direction - Direction angle in radians
   * @param interpolate - Function to interpolate between values
   */
  sample(
    worldX: number,
    worldY: number,
    direction: number,
    interpolate: (a: T, b: T, t: number) => T,
  ): T {
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

    // Bilinear interpolation for direction 0
    const v0_d0 = interpolate(v00_d0, v10_d0, fx);
    const v1_d0 = interpolate(v01_d0, v11_d0, fx);
    const v_d0 = interpolate(v0_d0, v1_d0, fy);

    // Bilinear interpolation for direction 1
    const v0_d1 = interpolate(v00_d1, v10_d1, fx);
    const v1_d1 = interpolate(v01_d1, v11_d1, fx);
    const v_d1 = interpolate(v0_d1, v1_d1, fy);

    // Interpolate between directions
    return interpolate(v_d0, v_d1, fd);
  }

  /**
   * Sample the grid at world coordinates for a single direction (no direction interpolation).
   * Useful when you need to query a specific pre-computed direction.
   *
   * @param worldX - World X coordinate
   * @param worldY - World Y coordinate
   * @param directionIndex - Integer direction index
   * @param interpolate - Function to interpolate between values
   */
  sampleAtDirection(
    worldX: number,
    worldY: number,
    directionIndex: number,
    interpolate: (a: T, b: T, t: number) => T,
  ): T {
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

    const v0 = interpolate(v00, v10, fx);
    const v1 = interpolate(v01, v11, fx);
    return interpolate(v0, v1, fy);
  }

  /**
   * Get the entire data array for a specific direction.
   * Useful for serialization or bulk operations.
   *
   * @param directionIndex - Integer direction index
   */
  getDirectionData(directionIndex: number): readonly T[] {
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;
    return this.data[dir];
  }

  /**
   * Set the entire data array for a specific direction.
   * Useful for deserialization or bulk operations.
   *
   * @param directionIndex - Integer direction index
   * @param data - Array of cell values
   */
  setDirectionData(directionIndex: number, data: T[]): void {
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;
    const cellCount = this.config.cellsX * this.config.cellsY;
    if (data.length !== cellCount) {
      throw new Error(
        `Data length ${data.length} does not match cell count ${cellCount}`,
      );
    }
    this.data[dir] = data;
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
   * Calls the callback with grid coordinates and current value.
   *
   * @param directionIndex - Integer direction index
   * @param callback - Function to call for each cell
   */
  forEachCell(
    directionIndex: number,
    callback: (gridX: number, gridY: number, value: T) => void,
  ): void {
    const dir =
      ((directionIndex % this.config.directionCount) +
        this.config.directionCount) %
      this.config.directionCount;
    for (let y = 0; y < this.config.cellsY; y++) {
      for (let x = 0; x < this.config.cellsX; x++) {
        callback(x, y, this.data[dir][this.getCellIndex(x, y)]);
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
