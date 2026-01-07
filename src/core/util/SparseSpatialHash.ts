import { V2d } from "../Vector";

const DEFAULT_CELL_SIZE = 10;

/**
 * Generic sparse spatial hash for efficient point queries.
 * Uses a Map so only non-empty cells exist in memory.
 *
 * @param T The type of items stored in the hash
 */
export class SparseSpatialHash<T> {
  private cellSize: number;
  private cells = new Map<number, T[]>();

  /**
   * @param getPosition Function to get an item's position
   * @param getRadius Function to get an item's influence radius
   * @param cellSize Size of each cell (default 10, roughly matches typical influence radius)
   */
  constructor(
    private getPosition: (item: T) => V2d,
    private getRadius: (item: T) => number,
    cellSize: number = DEFAULT_CELL_SIZE
  ) {
    this.cellSize = cellSize;
  }

  /** Convert world position to cell key */
  private getCellKey(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    // Bit-packed key handles negative coords (works for ±32768 cells)
    return ((cx + 0x8000) << 16) | ((cy + 0x8000) & 0xffff);
  }

  /** Add item to all cells its influence radius overlaps */
  add(item: T): void {
    const pos = this.getPosition(item);
    const r = this.getRadius(item);

    const minCX = Math.floor((pos.x - r) / this.cellSize);
    const maxCX = Math.floor((pos.x + r) / this.cellSize);
    const minCY = Math.floor((pos.y - r) / this.cellSize);
    const maxCY = Math.floor((pos.y + r) / this.cellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = ((cx + 0x8000) << 16) | ((cy + 0x8000) & 0xffff);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = [];
          this.cells.set(key, cell);
        }
        cell.push(item);
      }
    }
  }

  /** Query items that might affect a point */
  queryPoint(point: V2d): readonly T[] {
    const key = this.getCellKey(point.x, point.y);
    return this.cells.get(key) ?? [];
  }

  /** Clear all cells (call before rebuild) */
  clear(): void {
    this.cells.clear();
  }
}
