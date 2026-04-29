import { BaseEntity } from "../../core/entity/BaseEntity";
import { V, type V2d } from "../../core/Vector";

/**
 * A point light contributing to the screen-space lights texture.
 *
 * The LightingSystem rasterizes every Light entity each frame; the shape
 * shader fragment stage adds the result to the global ambient term, so a
 * Light brightens any nearby `lightAffected` geometry.
 */
export class Light extends BaseEntity {
  tags = ["light"];

  position: V2d;
  color: [number, number, number];
  /** World-space radius beyond which the light contributes nothing. */
  radius: number;
  /** Peak attenuation multiplier at the source (clamped to ≤ 1 by screen-blend in the shader). */
  intensity: number;
  /**
   * World-space distance at which the inverse-square term drops to 1/2.
   * Sets the "scale" of the bright core — the shader uses
   * `1 / (1 + (d / halfDistance)²)`, so at d = halfDistance brightness is
   * half its peak. Tighter halfDistance → concentrated, lantern-like;
   * larger halfDistance → softer, area-light-like. Defaults to radius/4.
   */
  halfDistance: number;

  constructor(
    opts: {
      position?: V2d;
      color?: readonly [number, number, number];
      radius?: number;
      intensity?: number;
      halfDistance?: number;
    } = {},
  ) {
    super();
    this.position = opts.position ?? V(0, 0);
    this.color = opts.color
      ? [opts.color[0], opts.color[1], opts.color[2]]
      : [1, 1, 1];
    this.radius = opts.radius ?? 30;
    this.intensity = opts.intensity ?? 1;
    this.halfDistance = opts.halfDistance ?? this.radius / 4;
  }
}
