import { V, type V2d } from "../../../core/Vector";
import type { ResultLayout } from "../query/QueryManager";

/**
 * Named constants for water result buffer layout
 */
export const WaterResultLayout: ResultLayout = {
  stride: 6,
  fields: {
    surfaceHeight: 0,
    velocityX: 1,
    velocityY: 2,
    normalX: 3,
    normalY: 4,
    depth: 5,
  },
};

/**
 * Zero-allocation view into water query result data.
 * Reads directly from a Float32Array buffer.
 * Vector getters return cached V2d instances. Do not mutate the returned vectors.
 */
export class WaterResultView {
  /** @internal */ _data!: Float32Array;
  /** @internal */ _offset!: number;

  private _velocity = V(0, 0);
  private _normal = V(0, 0);

  get surfaceHeight(): number {
    return this._data[this._offset + WaterResultLayout.fields.surfaceHeight];
  }

  get velocity(): V2d {
    this._velocity.set(
      this._data[this._offset + WaterResultLayout.fields.velocityX],
      this._data[this._offset + WaterResultLayout.fields.velocityY],
    );
    return this._velocity;
  }

  get normal(): V2d {
    this._normal.set(
      this._data[this._offset + WaterResultLayout.fields.normalX],
      this._data[this._offset + WaterResultLayout.fields.normalY],
    );
    return this._normal;
  }

  get depth(): number {
    return this._data[this._offset + WaterResultLayout.fields.depth];
  }
}
