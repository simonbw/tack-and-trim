import { V, type V2d } from "../../../core/Vector";
import type { ResultLayout } from "../query";

/**
 * Terrain type enum
 */
export enum TerrainType {
  Water = 0,
  Sand = 1,
  Grass = 2,
  Rock = 3,
}

/**
 * Named constants for terrain result buffer layout
 */
export const TerrainResultLayout: ResultLayout = {
  stride: 4,
  fields: {
    height: 0,
    normalX: 1,
    normalY: 2,
    terrainType: 3,
  },
};

/**
 * Zero-allocation view into terrain query result data.
 * Reads directly from a Float32Array buffer.
 */
export class TerrainResultView {
  /** @internal */ _data!: Float32Array;
  /** @internal */ _offset!: number;

  private _normal = V(0, 0);

  get height(): number {
    return this._data[this._offset + TerrainResultLayout.fields.height];
  }

  get normal(): V2d {
    this._normal.set(
      this._data[this._offset + TerrainResultLayout.fields.normalX],
      this._data[this._offset + TerrainResultLayout.fields.normalY],
    );
    return this._normal;
  }

  get terrainType(): TerrainType {
    return this._data[
      this._offset + TerrainResultLayout.fields.terrainType
    ] as TerrainType;
  }
}
