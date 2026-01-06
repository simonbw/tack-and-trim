import * as Pixi from "pixi.js";
import { V, V2d } from "../Vector";

/** TODO: Document LayerInfoOptions */
export interface LayerInfoOptions {
  parallax?: V2d;
  anchor?: V2d;
  filters?: Pixi.Filter[];
  alpha?: number;
}

/**
 * Info about a rendering layer.
 *
 * TODO: Document LayerInfo
 */
export class LayerInfo {
  readonly container: Pixi.Container;
  parallax: V2d;
  anchor: V2d;

  constructor({
    parallax = V(1.0, 1.0),
    anchor = V(0, 0),
    filters = [],
    alpha = 1.0,
  }: LayerInfoOptions = {}) {
    this.container = new Pixi.Container();
    this.parallax = parallax;
    this.anchor = anchor;
    this.container.filters = filters;
    this.container.alpha = alpha;
  }
}
