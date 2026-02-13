import { BaseEntity } from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { clamp, lerp } from "../core/util/MathUtil";
import { profile } from "../core/util/Profiler";
import { rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { WaterQuery } from "./world/water/WaterQuery";

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
  tickLayer = "effects" as const;

  private pos: V2d;
  private size: number;
  private age = 0;
  private lifespan = MAX_LIFESPAN;

  // Water query for foam particle position
  private waterQuery = this.addChild(new WaterQuery(() => [V(this.pos)]));

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

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    this.age += dt;
    if (this.age >= this.lifespan) {
      this.destroy();
      return;
    }

    // Move foam based on water surface velocity (from previous frame's query)
    const velocity =
      this.waterQuery.results.length > 0
        ? this.waterQuery.results[0].velocity
        : V(0, 0);
    this.pos.iaddScaled(velocity, dt);
  }

  @on("render")
  @profile
  onRender({ draw }: GameEventMap["render"]): void {
    const radius = this.getRadius();

    // Skip if not visible
    if (!draw.camera.isVisible(this.pos.x, this.pos.y, radius)) {
      return;
    }

    draw.fillCircle(this.pos.x, this.pos.y, radius, {
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
