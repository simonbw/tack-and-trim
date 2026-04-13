import { V, type V2d } from "../../../core/Vector";
import type { ResultLayout } from "../query/QueryManager";

/**
 * Named constants for wind result buffer layout
 */
export const WindResultLayout: ResultLayout = {
  stride: 4,
  fields: {
    velocityX: 0,
    velocityY: 1,
    speed: 2,
    direction: 3,
  },
};

/**
 * Zero-allocation view into wind query result data.
 * Reads directly from a Float32Array buffer.
 */
export class WindResultView {
  /** @internal */ _data!: Float32Array;
  /** @internal */ _offset!: number;

  private _velocity = V(0, 0);

  /**
   * True wind velocity in world frame — the direction the wind is blowing TOWARD,
   * not the direction it is coming from. For example, a northerly wind (blowing
   * from north to south) has velocity pointing south (negative Y in screen coords).
   *
   * To compute apparent/relative wind at a point on the boat:
   *   apparent_wind = wind_velocity - boat_point_velocity
   */
  get velocity(): V2d {
    this._velocity.set(
      this._data[this._offset + WindResultLayout.fields.velocityX],
      this._data[this._offset + WindResultLayout.fields.velocityY],
    );
    return this._velocity;
  }

  get speed(): number {
    return this._data[this._offset + WindResultLayout.fields.speed];
  }

  get direction(): number {
    return this._data[this._offset + WindResultLayout.fields.direction];
  }
}
