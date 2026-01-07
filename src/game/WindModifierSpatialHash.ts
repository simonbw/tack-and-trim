import { V2d } from "../core/Vector";
import { WindModifier } from "./WindModifier";

const DEFAULT_CELL_SIZE = 10; // Tunable - roughly matches typical influence radius

/**
 * Sparse spatial hash for efficient point queries against wind modifiers.
 * Uses a Map so only non-empty cells exist in memory.
 */
export class WindModifierSpatialHash {
  private cellSize: number;
  private cells = new Map<number, WindModifier[]>();

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  /** Convert world position to cell key */
  private getCellKey(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    // Bit-packed key handles negative coords (works for ±32768 cells)
    return ((cx + 0x8000) << 16) | ((cy + 0x8000) & 0xffff);
  }

  /** Add modifier to all cells its influence radius overlaps */
  addModifier(modifier: WindModifier): void {
    const pos = modifier.getWindModifierPosition();
    const r = modifier.getWindModifierInfluenceRadius();

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
        cell.push(modifier);
      }
    }
  }

  /** Query modifiers that might affect a point */
  queryPoint(point: V2d): readonly WindModifier[] {
    const key = this.getCellKey(point.x, point.y);
    return this.cells.get(key) ?? [];
  }

  /** Clear all cells (call before rebuild) */
  clear(): void {
    this.cells.clear();
  }
}
