import type { V2d } from "../../../core/Vector";
import { BaseQuery } from "../query";
import { WindResultLayout, WindResultView } from "./WindQueryResult";

/**
 * Entity that queries wind data at multiple points each frame.
 */

export class WindQuery extends BaseQuery<WindResultView> {
  tags = ["windQuery"];
  readonly stride = WindResultLayout.stride;

  private views: WindResultView[] = [];

  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }

  get(index: number): WindResultView {
    let view = this.views[index];
    if (!view) {
      view = new WindResultView();
      this.views[index] = view;
    }
    view._data = this._data;
    view._offset = index * this.stride;
    return view;
  }
}
