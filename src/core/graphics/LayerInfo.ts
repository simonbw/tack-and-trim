import { V, V2d } from "../Vector";

/** Depth buffer interaction mode for a layer */
export type DepthMode = "none" | "read-write" | "always-write";

/** Options for layer configuration */
export interface LayerInfoOptions {
  /** Parallax factor for camera movement. V(1,1) = moves with camera, V(0,0) = fixed on screen */
  parallax?: V2d;
  /** Anchor point for parallax transformations */
  anchor?: V2d;
  /** Layer transparency (0-1) */
  alpha?: number;
  /**
   * Depth buffer interaction mode:
   * - "none" (default): pipeline uses depthCompare "always", no depth write
   * - "read-write": pipeline uses depthCompare "greater-equal" with depth write enabled
   * - "always-write": pipeline uses depthCompare "always" with depth write (draws on top, writes z for overlays)
   */
  depth?: DepthMode;
}

/**
 * Configuration for a rendering layer.
 * Layers are rendered in order and can have different parallax settings.
 */
export class LayerInfo {
  /** Parallax factor for this layer */
  parallax: V2d;
  /** Anchor point for parallax transformations */
  anchor: V2d;
  /** Layer transparency */
  alpha: number;
  /** Depth buffer interaction mode */
  depth: DepthMode;

  constructor({
    parallax = V(1.0, 1.0),
    anchor = V(0, 0),
    alpha = 1.0,
    depth = "none",
  }: LayerInfoOptions = {}) {
    this.parallax = parallax;
    this.anchor = anchor;
    this.alpha = alpha;
    this.depth = depth;
  }
}
