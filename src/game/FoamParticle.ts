import { BaseEntity } from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { clamp, lerp } from "../core/util/MathUtil";
import { profile } from "../core/util/Profiler";
import { rUniform } from "../core/util/Random";
import type { AABB } from "../core/util/SparseSpatialHash";
import { V2d } from "../core/Vector";
import type { QueryForecast } from "./world-data/datatiles/DataTileTypes";
import type { WaterQuerier } from "./world-data/water/WaterQuerier";
import { WaterInfo } from "./world-data/water/WaterInfo";

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
export class FoamParticle extends BaseEntity implements WaterQuerier {
  layer = "foamParticles" as const;
  tickLayer = "effects" as const;
  tags = ["waterQuerier"];

  private pos: V2d;
  private size: number;
  private age = 0;
  private lifespan = MAX_LIFESPAN;

  /**
   * Create a new foam particle.
   * @param pos World position (x, y)
   * @param size Initial size (radius) in ft
   */
  // Reusable AABB to avoid allocations
  private aabb: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(pos: V2d, size: number) {
    super();
    this.pos = pos;
    this.size = size;
    this.lifespan = rUniform(0, MAX_LIFESPAN);
  }

  getWaterQueryForecast(): QueryForecast {
    this.aabb.minX = this.pos[0];
    this.aabb.maxX = this.pos[0];
    this.aabb.minY = this.pos[1];
    this.aabb.maxY = this.pos[1];
    return { aabb: this.aabb, queryCount: 1 };
  }

  @on("tick")
  onTick(dt: number): void {
    this.age += dt;
    if (this.age >= this.lifespan) {
      this.destroy();
      return;
    }

    // Move foam based on water surface velocity
    const waterInfo = WaterInfo.fromGame(this.game);
    const state = waterInfo.getStateAtPoint(this.pos);
    this.pos.iaddScaled(state.velocity, dt);
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
