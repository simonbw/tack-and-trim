import type { V2d } from "../../../core/Vector";
import { BaseQuery } from "../query/BaseQuery";
import { TerrainResultLayout, TerrainResultView } from "./TerrainQueryResult";

/**
 * Entity that queries terrain data at multiple points each frame.
 */
export class TerrainQuery extends BaseQuery<TerrainResultView> {
  tags = ["terrainQuery"];
  readonly stride = TerrainResultLayout.stride;

  private views: TerrainResultView[] = [];

  constructor(getPoints: () => ReadonlyArray<V2d>) {
    super(getPoints);
  }

  get(index: number): TerrainResultView {
    let view = this.views[index];
    if (!view) {
      view = new TerrainResultView();
      this.views[index] = view;
    }
    view._data = this._data;
    view._offset = index * this.stride;
    return view;
  }
}
