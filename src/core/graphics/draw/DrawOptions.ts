/** Options for shape drawing */
export interface DrawOptions {
  color?: number; // 0xRRGGBB
  alpha?: number; // 0-1
}

/** Options for line drawing */
export interface LineOptions extends DrawOptions {
  width?: number;
}

/** Options for smooth polygon drawing */
export interface SmoothOptions extends DrawOptions {
  tension?: number; // 0-1, default 0.5
}

/** Options for spline drawing */
export interface SplineOptions extends LineOptions {
  tension?: number; // 0-1, default 0.5
}

/** Options for sprite/image drawing */
export interface ImageOptions {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  tint?: number; // 0xRRGGBB - tint color
  anchorX?: number; // 0-1, default 0.5
  anchorY?: number; // 0-1, default 0.5
}

/** Options for circle drawing */
export interface CircleOptions extends DrawOptions {
  /** Number of segments to use. If not specified, calculated from radius. */
  segments?: number;
}
