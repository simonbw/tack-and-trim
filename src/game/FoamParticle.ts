import BaseEntity from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { clamp, lerp } from "../core/util/MathUtil";
import { profile } from "../core/util/Profiler";
import { rUniform } from "../core/util/Random";
import { V2d } from "../core/Vector";

// Rendering
const COLOR = 0xffffff;
const ALPHA = 0.8;

// Foam lifecycle
const MAX_LIFESPAN = 4.0; // seconds
const GROW_SPEED = 1.0; // radiuses per second

/**
 * A foam particle on the water surface.
 * Created when a SprayParticle hits the water.
 * Grows outward and fades over time.
 */
export class FoamParticle extends BaseEntity {
  layer = "foamParticles" as const;

  private pos: V2d;
  private size: number;
  private age = 0;
  private lifespan = MAX_LIFESPAN;

  /**
   * Create a new foam particle.
   * @param pos World position (x, y)
   * @param size Initial size (radius) in ft
   */
  constructor(pos: V2d, size: number) {
    super();
    this.pos = pos;
    this.size = size;
    this.lifespan = rUniform(0, MAX_LIFESPAN);
  }

  onTick(dt: number): void {
    this.age += dt;
    if (this.age >= this.lifespan) {
      this.destroy();
      return;
    }
  }

  @profile
  onRender({ draw }: GameEventMap["render"]): void {
    draw.camera;
    draw.fillCircle(this.pos.x, this.pos.y, this.getRadius(), {
      color: COLOR,
      alpha: this.getAlpha(),
    });
  }

  private getAlpha(): number {
    const t = clamp(this.age / this.lifespan);
    return lerp(ALPHA, 0, t ** 2);
  }

  private getRadius(): number {
    return this.size * (GROW_SPEED * (1 + Math.sqrt(this.age)));
  }
}
