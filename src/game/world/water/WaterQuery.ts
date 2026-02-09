import type { V2d } from "../../../core/Vector";
import { BaseQuery } from "../query/BaseQuery";
import { WaterResultLayout, WaterResultView } from "./WaterQueryResult";

/**
 * Entity that queries water data at multiple points each frame.
 */
export class WaterQuery extends BaseQuery<WaterResultView> {
  tags = ["waterQuery"];
  readonly stride = WaterResultLayout.stride;

  private views: WaterResultView[] = [];

  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }

  get(index: number): WaterResultView {
    let view = this.views[index];
    if (!view) {
      view = new WaterResultView();
      this.views[index] = view;
    }
    view._data = this._data;
    view._offset = index * this.stride;
    return view;
  }
}
