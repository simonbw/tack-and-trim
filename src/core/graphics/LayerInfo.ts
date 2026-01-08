import { V, V2d } from "../Vector";

/** Options for layer configuration */
export interface LayerInfoOptions {
  /** Parallax factor for camera movement. V(1,1) = moves with camera, V(0,0) = fixed on screen */
  parallax?: V2d;
  /** Anchor point for parallax transformations */
  anchor?: V2d;
  /** Layer transparency (0-1) */
  alpha?: number;
}

/**
 * Configuration for a rendering layer.
 * Layers are rendered in order and can have different parallax settings.
 * No longer wraps a Pixi.Container - just stores config.
 */
export class LayerInfo {
  /** Parallax factor for this layer */
  parallax: V2d;
  /** Anchor point for parallax transformations */
  anchor: V2d;
  /** Layer transparency */
  alpha: number;

  constructor({
    parallax = V(1.0, 1.0),
    anchor = V(0, 0),
    alpha = 1.0,
  }: LayerInfoOptions = {}) {
    this.parallax = parallax;
    this.anchor = anchor;
    this.alpha = alpha;
  }
}
